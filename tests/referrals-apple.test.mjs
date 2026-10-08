// Referral rewards for Apple (iPhone) subscribers, end to end:
//
//   - api/_lib/appStoreServer.js: the ES256 token and the "Extend a
//     Subscription Renewal Date" PUT (fetch is stubbed; the JWT is verified
//     against a P-256 keypair generated here).
//   - api/billing/revenuecat-webhook.js: a trial-conversion event marks the
//     referral converted and rewards both sides; every RENEWAL sweeps.
//   - api/_lib/referrals.js: ledger + platform routing, Apple banking under
//     the two-per-365-days rule, batching, the 90-day cap, Stripe recipients
//     unchanged, pending referrers paid on their first Apple renewal, and
//     attachReferralCode's guard rails.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/referrals-apple.test.mjs

import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import {
  setCode,
  recordReferralSignup,
  markReferralConverted,
  grantPendingReferralCredits,
  applyBankedAppleWeeks,
  getRewardSummary,
  attachReferralCode,
  billingPlatform,
  REWARD_CENTS,
} from '../api/_lib/referrals.js';
import { appleConfigured, mintToken, extendRenewalDate } from '../api/_lib/appStoreServer.js';

const WEBHOOK_SECRET = 'rc_test_secret_at_least_long_enough';
process.env.REVENUECAT_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';

const { default: rcHandler } = await import('../api/billing/revenuecat-webhook.js');

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

// ── Apple test keypair ───────────────────────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const APPLE_ENV = {
  APP_STORE_ISSUER_ID: '57246542-96fe-1a63-e053-0824d011072a',
  APP_STORE_KEY_ID: 'ABC123DEFG',
  APP_STORE_BUNDLE_ID: 'ai.joinivy.app',
  // Exercise the literal "\n" tolerance: store the PEM single-line.
  APP_STORE_PRIVATE_KEY: PRIVATE_PEM.replace(/\n/g, '\\n'),
};
function configureApple() { Object.assign(process.env, APPLE_ENV); }
function unconfigureApple() { for (const k of Object.keys(APPLE_ENV)) delete process.env[k]; }

// ── fetch stub: Apple + Stripe + mail ────────────────────────────────
const realFetch = globalThis.fetch;
let appleCalls = [];
let stripeCalls = [];
let appleShouldFail = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/inApps/v1/subscriptions/extend/')) {
    appleCalls.push({ url: u, method: opts.method, headers: opts.headers || {}, body: JSON.parse(opts.body) });
    if (appleShouldFail) {
      return { ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ errorCode: 4000030, errorMessage: 'Extension limit reached' }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, originalTransactionId: 'x', effectiveDate: Date.now() + 86400000 }) };
  }
  if (u.includes('/balance_transactions')) {
    stripeCalls.push({ url: u, body: opts.body });
    return { ok: true, status: 200, json: async () => ({ id: 'cbtxn_test', amount: -REWARD_CENTS }) };
  }
  if (u.includes('resend.com')) {
    return { ok: true, status: 200, json: async () => ({ id: 'email_test' }), text: async () => '{}' };
  }
  throw new Error(`unexpected fetch in test: ${u}`);
};

// ── fixtures ─────────────────────────────────────────────────────────
const created = { users: [] };
let seq = 0;
async function mkUser(label) {
  const r = await sql`
    INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`rapple-${label}-${Date.now()}-${seq++}@example.com`}, 'x', '2026-05-05', NOW())
    RETURNING id
  `;
  created.users.push(r.rows[0].id);
  return r.rows[0].id;
}
async function mkWorkspace(ownerId) {
  const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`;
  return w.rows[0].id;
}
// An Apple-billed, paying owner (trial already converted).
async function makeApplePaying(wid, txn) {
  await sql`
    UPDATE workspaces SET subscription_status = 'active', subscription_source = 'apple',
      revenuecat_user_id = ${wid}, apple_original_transaction_id = ${txn},
      converted_at = NOW(), trial_started_at = NOW() - INTERVAL '14 days'
    WHERE id = ${wid}
  `;
}
async function makeStripePaying(wid, customer) {
  await sql`
    UPDATE workspaces SET subscription_status = 'active', subscription_source = 'stripe',
      stripe_customer_id = ${customer}, converted_at = NOW()
    WHERE id = ${wid}
  `;
}

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s)  { this.body = s; return this; },
  };
}
function rcEvent(type, workspaceId, extra = {}) {
  return {
    id: `rc_evt_${Date.now()}_${seq++}`,
    type,
    app_user_id: workspaceId,
    product_id: 'ivyos_weekly',
    expiration_at_ms: Date.now() + 7 * 86400 * 1000,
    ...extra,
  };
}
async function postRc(event) {
  const res = mkRes();
  await rcHandler({
    method: 'POST', url: '/api/billing/revenuecat-webhook',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${WEBHOOK_SECRET}` },
    body: JSON.stringify({ event }),
  }, res);
  return res;
}
// Trial start, then the renewal that converts it: what RevenueCat sends
// for an iPhone owner who finishes the 14-day trial and gets charged.
async function appleTrialThenConvert(wid, txn) {
  await postRc(rcEvent('INITIAL_PURCHASE', wid, { period_type: 'TRIAL', original_transaction_id: txn }));
  return postRc(rcEvent('RENEWAL', wid, { period_type: 'NORMAL', is_trial_conversion: true, original_transaction_id: txn }));
}
async function ledgerFor(wid) {
  const r = await sql`
    SELECT side, weeks, method, applied_at, note, apple_request_id FROM referral_reward_ledger
    WHERE workspace_id = ${wid} ORDER BY created_at ASC
  `;
  return r.rows;
}
const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

async function run() {
  try {
    await ensureSchemaApplied();
    configureApple();

    console.log('\n[1] mintToken: ES256 JWT with the right claims, verifiable with the public key');
    assert(appleConfigured() === true, 'appleConfigured() true once the four vars are set');
    const token = mintToken({ now: 1_800_000_000_000 });
    const [h, p, sig] = token.split('.');
    const header = b64json(h);
    const payload = b64json(p);
    assert(header.alg === 'ES256' && header.typ === 'JWT' && header.kid === APPLE_ENV.APP_STORE_KEY_ID, 'header has alg ES256, typ JWT, kid = APP_STORE_KEY_ID');
    assert(payload.iss === APPLE_ENV.APP_STORE_ISSUER_ID, 'iss = APP_STORE_ISSUER_ID');
    assert(payload.aud === 'appstoreconnect-v1', 'aud = appstoreconnect-v1');
    assert(payload.bid === APPLE_ENV.APP_STORE_BUNDLE_ID, 'bid = bundle id');
    assert(payload.iat === 1_800_000_000 && payload.exp === payload.iat + 1200, 'exp = iat + 1200');
    const rawSig = Buffer.from(sig, 'base64url');
    assert(rawSig.length === 64, 'signature is raw r||s (64 bytes), not DER');
    const verified = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, rawSig);
    assert(verified === true, 'signature verifies with the test public key');
    assert(!token.includes('PRIVATE'), 'token never carries the key');
    unconfigureApple();
    assert(appleConfigured() === false, 'appleConfigured() false when vars are missing');
    let threw = false;
    try { mintToken(); } catch { threw = true; }
    assert(threw, 'mintToken throws when unconfigured');
    configureApple();

    console.log('\n[2] extendRenewalDate: PUT to Apple with the transaction id, days, reason and bearer');
    appleCalls = [];
    const ext = await extendRenewalDate({ originalTransactionId: 'txn_direct_1', days: 7 });
    assert(ext.ok === true && ext.status === 200, 'ok on 200');
    assert(ext.effectiveDate instanceof Date, 'effectiveDate parsed from Apple response');
    assert(appleCalls.length === 1, 'exactly one PUT');
    const call = appleCalls[0];
    assert(call.method === 'PUT', 'method is PUT');
    assert(call.url === 'https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/extend/txn_direct_1', 'URL is the production extend endpoint with the original transaction id');
    assert(call.body.extendByDays === 7 && call.body.extendReasonCode === 1, 'body carries extendByDays and extendReasonCode 1');
    assert(typeof call.body.requestIdentifier === 'string' && call.body.requestIdentifier.length >= 32, 'body carries a requestIdentifier');
    const bearer = String(call.headers.Authorization || '');
    assert(bearer.startsWith('Bearer '), 'Authorization is a Bearer token');
    const [bh, bp, bs] = bearer.slice(7).split('.');
    assert(b64json(bh).kid === APPLE_ENV.APP_STORE_KEY_ID && b64json(bp).iss === APPLE_ENV.APP_STORE_ISSUER_ID, 'bearer JWT decodes to the right kid/iss');
    assert(crypto.verify('sha256', Buffer.from(`${bh}.${bp}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(bs, 'base64url')), 'bearer JWT verifies');
    process.env.APP_STORE_ENV = 'sandbox';
    appleCalls = [];
    await extendRenewalDate({ originalTransactionId: 'txn_sb', days: 7 });
    assert(appleCalls[0].url.startsWith('https://api.storekit-sandbox.itunes.apple.com/'), 'sandbox host when APP_STORE_ENV=sandbox');
    delete process.env.APP_STORE_ENV;
    const bad = await extendRenewalDate({ originalTransactionId: 'txn_sb', days: 91 });
    assert(bad.ok === false && /between 1 and 90/.test(bad.error), 'refuses more than 90 days locally');
    appleShouldFail = true; appleCalls = [];
    const failed = await extendRenewalDate({ originalTransactionId: 'txn_sb', days: 7 });
    assert(failed.ok === false && failed.status === 400 && /4000030/.test(failed.error), 'Apple error surfaces status + errorCode, no throw');
    appleShouldFail = false;

    console.log('\n[3] RevenueCat trial conversion rewards the referrer on Apple');
    const refA = await mkUser('refA');
    const wsA = await mkWorkspace(refA);
    await makeApplePaying(wsA, 'apple_txn_refA');
    await setCode(refA, 'apple-ref-a');
    const feeA = await mkUser('feeA');
    const wsFeeA = await mkWorkspace(feeA);
    await recordReferralSignup({ referredUserId: feeA, rawCode: 'apple-ref-a' });
    assert(billingPlatform((await sql`SELECT * FROM workspaces WHERE id = ${wsA}`).rows[0]) === 'apple', 'billingPlatform → apple for an RC-billed workspace');
    appleCalls = []; stripeCalls = [];
    const trialRes = await postRc(rcEvent('INITIAL_PURCHASE', wsFeeA, { period_type: 'TRIAL', original_transaction_id: 'apple_txn_feeA' }));
    assert(trialRes.statusCode === 200, 'trial INITIAL_PURCHASE → 200');
    let refRow = (await sql`SELECT converted_at FROM referrals WHERE referred_user_id = ${feeA}`).rows[0];
    assert(refRow.converted_at === null, 'trial start does NOT convert the referral');
    assert(appleCalls.length === 0, 'no extension during the trial');
    const convRes = await postRc(rcEvent('RENEWAL', wsFeeA, { period_type: 'NORMAL', is_trial_conversion: true, original_transaction_id: 'apple_txn_feeA' }));
    assert(convRes.statusCode === 200, 'trial-conversion RENEWAL → 200');
    refRow = (await sql`SELECT converted_at, rewarded_at, referred_rewarded_at FROM referrals WHERE referred_user_id = ${feeA}`).rows[0];
    assert(refRow.converted_at !== null, 'referral converted on the first real charge');
    assert(refRow.rewarded_at !== null && refRow.referred_rewarded_at === null, 'the referrer earned; the referred owner did not');
    assert(appleCalls.length === 1, 'one Apple extension, for the referrer');
    const txns = appleCalls.map((c) => c.url.split('/').pop()).sort();
    assert(txns.join(',') === 'apple_txn_refA', 'the extension targets the referrer\'s original transaction id');
    assert(appleCalls.every((c) => c.body.extendByDays === 7), 'each extension is 7 days');
    const ledA = await ledgerFor(wsA);
    const ledFeeA = await ledgerFor(wsFeeA);
    assert(ledA.length === 1 && ledA[0].side === 'referrer' && ledA[0].method === 'apple_extension' && ledA[0].applied_at, 'referrer ledger row applied via apple_extension');
    assert(ledFeeA.length === 0, 'no ledger row for the referred owner');
    const extRows = await sql`SELECT days FROM apple_renewal_extensions WHERE workspace_id = ${wsA}`;
    assert(extRows.rows.length === 1 && extRows.rows[0].days === 7, 'extension recorded in apple_renewal_extensions');
    assert(stripeCalls.length === 0, 'no Stripe credit for Apple owners');
    // Replay the same conversion: idempotent.
    appleCalls = [];
    await postRc(rcEvent('RENEWAL', wsFeeA, { period_type: 'NORMAL', original_transaction_id: 'apple_txn_feeA' }));
    assert(appleCalls.length === 0, 'a later RENEWAL does not re-reward');
    assert((await ledgerFor(wsA)).length === 1, 'ledger still has one referrer row');

    console.log('\n[4] two-per-365-days: the third week is banked with nextEligibleAt');
    appleCalls = [];
    const feeA2 = await mkUser('feeA2');
    await mkWorkspace(feeA2);
    await recordReferralSignup({ referredUserId: feeA2, rawCode: 'apple-ref-a' });
    await markReferralConverted(feeA2); // referee has no platform: only the referrer side pays out
    assert(appleCalls.length === 1 && appleCalls[0].url.endsWith('/apple_txn_refA'), 'second conversion uses the second extension slot');
    appleCalls = [];
    const feeA3 = await mkUser('feeA3');
    await mkWorkspace(feeA3);
    await recordReferralSignup({ referredUserId: feeA3, rawCode: 'apple-ref-a' });
    await markReferralConverted(feeA3);
    assert(appleCalls.length === 0, 'third conversion makes NO Apple call (limit reached)');
    let sumA = await getRewardSummary(refA);
    assert(sumA.platform === 'apple' && sumA.earnedWeeks === 3 && sumA.appliedWeeks === 2 && sumA.bankedWeeks === 1, 'summary: 3 earned, 2 applied, 1 banked');
    const oldest = (await sql`SELECT MIN(created_at) AS t FROM apple_renewal_extensions WHERE workspace_id = ${wsA}`).rows[0].t;
    const expectedNext = new Date(new Date(oldest).getTime() + 365 * 86400 * 1000).getTime();
    assert(sumA.nextEligibleAt && Math.abs(new Date(sumA.nextEligibleAt).getTime() - expectedNext) < 5000, 'nextEligibleAt = oldest extension + 365 days');
    const sweepA = await applyBankedAppleWeeks(wsA);
    assert(sweepA.reason === 'apple-limit' && sweepA.bankedWeeks === 1 && sweepA.nextEligibleAt, 'sweep reports apple-limit and keeps the week banked');
    // Age the oldest extension out of the window: the slot reopens and the banked week goes out.
    await sql`
      UPDATE apple_renewal_extensions SET created_at = NOW() - INTERVAL '366 days'
      WHERE id = (SELECT id FROM apple_renewal_extensions WHERE workspace_id = ${wsA} ORDER BY created_at ASC LIMIT 1)
    `;
    appleCalls = [];
    const reopened = await applyBankedAppleWeeks(wsA);
    assert(reopened.appliedWeeks === 1 && appleCalls.length === 1 && appleCalls[0].body.extendByDays === 7, 'once the window reopens the banked week is delivered');
    sumA = await getRewardSummary(refA);
    assert(sumA.bankedWeeks === 0 && sumA.nextEligibleAt === null, 'nothing banked afterwards');

    console.log('\n[5] batching: 3 banked weeks go out as one 21-day extension');
    const refB = await mkUser('refB');
    const wsB = await mkWorkspace(refB);
    await makeApplePaying(wsB, 'apple_txn_refB');
    await setCode(refB, 'apple-ref-b');
    unconfigureApple(); // weeks earn but cannot be delivered yet
    appleCalls = [];
    for (const l of ['b1', 'b2', 'b3']) {
      const fee = await mkUser(l);
      await mkWorkspace(fee);
      await recordReferralSignup({ referredUserId: fee, rawCode: 'apple-ref-b' });
      await markReferralConverted(fee);
    }
    let ledB = await ledgerFor(wsB);
    assert(ledB.length === 3 && ledB.every((r) => !r.applied_at && r.note === 'apple-not-configured'), '3 ledger rows banked with note apple-not-configured');
    assert(appleCalls.length === 0, 'no Apple call while unconfigured');
    let sumB = await getRewardSummary(refB);
    assert(sumB.earnedWeeks === 3 && sumB.bankedWeeks === 3 && sumB.nextEligibleAt === null, 'summary: 3 banked, no Apple date (slots are free)');
    configureApple();
    const batch = await applyBankedAppleWeeks(wsB);
    assert(batch.appliedWeeks === 3 && batch.days === 21, 'sweep applies 3 weeks as 21 days');
    assert(appleCalls.length === 1 && appleCalls[0].body.extendByDays === 21, 'ONE Apple call with extendByDays 21');
    ledB = await ledgerFor(wsB);
    assert(ledB.every((r) => r.applied_at && r.method === 'apple_extension' && r.note === null), 'all 3 rows applied, notes cleared');
    const extB = await sql`SELECT days FROM apple_renewal_extensions WHERE workspace_id = ${wsB}`;
    assert(extB.rows.length === 1 && extB.rows[0].days === 21, 'one 21-day extension recorded');

    console.log('\n[6] 90-day cap: 14 banked weeks → 84 days now, 2 stay banked');
    const refC = await mkUser('refC');
    const wsC = await mkWorkspace(refC);
    await makeApplePaying(wsC, 'apple_txn_refC');
    await setCode(refC, 'apple-ref-c');
    unconfigureApple();
    for (let i = 0; i < 14; i++) {
      const fee = await mkUser(`c${i}`);
      await mkWorkspace(fee);
      await recordReferralSignup({ referredUserId: fee, rawCode: 'apple-ref-c' });
      await markReferralConverted(fee);
    }
    configureApple();
    appleCalls = [];
    const capped = await applyBankedAppleWeeks(wsC);
    assert(capped.appliedWeeks === 12 && capped.days === 84 && capped.bankedWeeks === 2, 'sweep applies 12 weeks (84 days), banks 2');
    assert(appleCalls.length === 1 && appleCalls[0].body.extendByDays === 84 && appleCalls[0].body.extendByDays <= 90, 'Apple call capped under 90 days');
    const ledC = await ledgerFor(wsC);
    assert(ledC.filter((r) => r.applied_at).length === 12 && ledC.filter((r) => !r.applied_at).length === 2, 'ledger: 12 applied, 2 banked');
    appleCalls = [];
    const second = await applyBankedAppleWeeks(wsC);
    assert(second.appliedWeeks === 2 && appleCalls[0]?.body.extendByDays === 14, 'next sweep delivers the remaining 2 weeks (14 days)');

    console.log('\n[7] Stripe recipients still get the balance credit');
    const refD = await mkUser('refD');
    const wsD = await mkWorkspace(refD);
    await makeStripePaying(wsD, 'cus_refD');
    await setCode(refD, 'stripe-ref-d');
    const feeD = await mkUser('feeD');
    const wsFeeD = await mkWorkspace(feeD);
    await recordReferralSignup({ referredUserId: feeD, rawCode: 'stripe-ref-d' });
    appleCalls = []; stripeCalls = [];
    await appleTrialThenConvert(wsFeeD, 'apple_txn_feeD');
    assert(stripeCalls.length === 1 && stripeCalls[0].url.includes('cus_refD'), 'Stripe referrer credited on their customer balance');
    assert((stripeCalls[0].body || '').includes(`amount=-${REWARD_CENTS}`), 'credit is one week\'s price');
    assert(appleCalls.length === 0, 'the Apple referred owner gets no extension');
    const ledD = await ledgerFor(wsD);
    assert(ledD.length === 1 && ledD[0].method === 'stripe_credit' && ledD[0].applied_at, 'referrer ledger row: stripe_credit, applied');
    const sumD = await getRewardSummary(refD);
    assert(sumD.platform === 'stripe' && sumD.appliedWeeks === 1 && sumD.bankedWeeks === 0, 'Stripe summary: applied, nothing banked');
    // And a Stripe referee of an Apple referrer: welcome week as a credit.
    const feeD2 = await mkUser('feeD2');
    const wsFeeD2 = await mkWorkspace(feeD2);
    await makeStripePaying(wsFeeD2, 'cus_feeD2');
    await recordReferralSignup({ referredUserId: feeD2, rawCode: 'apple-ref-b' });
    appleCalls = []; stripeCalls = [];
    await markReferralConverted(feeD2);
    assert(!stripeCalls.some((c) => c.url.includes('cus_feeD2')), 'the Stripe referred owner gets no credit');
    assert(appleCalls.length === 1 && appleCalls[0].url.endsWith('/apple_txn_refB'), 'Apple referrer gets a 7-day extension for it');

    console.log('\n[8] referrer not yet subscribed stays pending, paid on first Apple RENEWAL');
    const refE = await mkUser('refE');
    const wsE = await mkWorkspace(refE);
    await sql`UPDATE workspaces SET subscription_status = 'trialing' WHERE id = ${wsE}`;
    await setCode(refE, 'pending-ref-e');
    const feeE = await mkUser('feeE');
    const wsFeeE = await mkWorkspace(feeE);
    await makeStripePaying(wsFeeE, 'cus_feeE');
    await recordReferralSignup({ referredUserId: feeE, rawCode: 'pending-ref-e' });
    appleCalls = []; stripeCalls = [];
    await markReferralConverted(feeE);
    let rowE = (await sql`SELECT rewarded_at FROM referrals WHERE referred_user_id = ${feeE}`).rows[0];
    assert(rowE.rewarded_at === null, 'referrer reward pending (no platform yet)');
    assert((await ledgerFor(wsE)).length === 0, 'no ledger row for the pending referrer');
    assert(appleCalls.length === 0 && stripeCalls.length === 0, 'nothing goes out yet: the referrer is pending and the referred owner earns nothing');
    // Referrer starts an Apple trial: still pending.
    await postRc(rcEvent('INITIAL_PURCHASE', wsE, { period_type: 'TRIAL', original_transaction_id: 'apple_txn_refE' }));
    rowE = (await sql`SELECT rewarded_at FROM referrals WHERE referred_user_id = ${feeE}`).rows[0];
    assert(rowE.rewarded_at === null && appleCalls.length === 0, 'Apple trial start does not pay the pending reward');
    // First real Apple charge: swept.
    appleCalls = [];
    const renewE = await postRc(rcEvent('RENEWAL', wsE, { period_type: 'NORMAL', is_trial_conversion: true, original_transaction_id: 'apple_txn_refE' }));
    assert(renewE.statusCode === 200, 'first Apple RENEWAL → 200');
    rowE = (await sql`SELECT rewarded_at FROM referrals WHERE referred_user_id = ${feeE}`).rows[0];
    assert(rowE.rewarded_at !== null, 'pending reward earned on the referrer\'s first Apple charge');
    assert(appleCalls.length === 1 && appleCalls[0].url.endsWith('/apple_txn_refE') && appleCalls[0].body.extendByDays === 7, 'delivered as a 7-day extension on the referrer\'s subscription');
    const ledE = await ledgerFor(wsE);
    assert(ledE.length === 1 && ledE[0].applied_at && ledE[0].method === 'apple_extension', 'ledger row applied');

    console.log('\n[9] RENEWAL without the is_trial_conversion flag still converts (safety net)');
    const feeF = await mkUser('feeF');
    const wsFeeF = await mkWorkspace(feeF);
    await recordReferralSignup({ referredUserId: feeF, rawCode: 'stripe-ref-d' });
    await postRc(rcEvent('INITIAL_PURCHASE', wsFeeF, { period_type: 'TRIAL', original_transaction_id: 'apple_txn_feeF' }));
    stripeCalls = []; appleCalls = [];
    await postRc(rcEvent('RENEWAL', wsFeeF, { period_type: 'NORMAL', original_transaction_id: 'apple_txn_feeF' }));
    const rowF = (await sql`SELECT converted_at FROM referrals WHERE referred_user_id = ${feeF}`).rows[0];
    assert(rowF.converted_at !== null, 'converted on a NORMAL renewal with no flag');
    assert(stripeCalls.length === 1 && appleCalls.length === 0, 'the Stripe referrer is credited; the Apple referred owner gets nothing');
    // A no-trial purchase converts too.
    const feeG = await mkUser('feeG');
    const wsFeeG = await mkWorkspace(feeG);
    await recordReferralSignup({ referredUserId: feeG, rawCode: 'stripe-ref-d' });
    stripeCalls = []; appleCalls = [];
    await postRc(rcEvent('INITIAL_PURCHASE', wsFeeG, { period_type: 'NORMAL', original_transaction_id: 'apple_txn_feeG' }));
    const rowG = (await sql`SELECT converted_at FROM referrals WHERE referred_user_id = ${feeG}`).rows[0];
    assert(rowG.converted_at !== null && stripeCalls.length === 1 && appleCalls.length === 0, 'INITIAL_PURCHASE with period NORMAL converts and rewards the referrer');

    console.log('\n[10] attachReferralCode guard rails');
    const refH = await mkUser('refH');
    await mkWorkspace(refH);
    await setCode(refH, 'attach-ref-h');
    const joiner = await mkUser('joiner');
    const wsJoiner = await mkWorkspace(joiner);
    const self = await attachReferralCode(refH, 'attach-ref-h');
    assert(self.ok === false && self.reason === 'self-referral', 'cannot attach your own code');
    const unknown = await attachReferralCode(joiner, 'no-such-code-xyz');
    assert(unknown.ok === false && unknown.reason === 'unknown-code', 'unknown code rejected');
    const empty = await attachReferralCode(joiner, '');
    assert(empty.ok === false && empty.reason === 'bad-code', 'empty code rejected');
    const okAttach = await attachReferralCode(joiner, 'attach-ref-h');
    assert(okAttach.ok === true && okAttach.code === 'ATTACH-REF-H', 'valid code attaches');
    const row = (await sql`SELECT referrer_user_id FROM referrals WHERE referred_user_id = ${joiner}`).rows[0];
    assert(row?.referrer_user_id === refH, 'referral row points at the code owner');
    const again = await attachReferralCode(joiner, 'stripe-ref-d');
    assert(again.ok === false && again.reason === 'already-attached', 'only one referral per account');
    const converted = await mkUser('converted');
    const wsConv = await mkWorkspace(converted);
    await makeStripePaying(wsConv, 'cus_conv');
    const afterPay = await attachReferralCode(converted, 'attach-ref-h');
    assert(afterPay.ok === false && afterPay.reason === 'converted', 'not after the first payment');
    const old = await mkUser('old');
    await mkWorkspace(old);
    await sql`UPDATE users SET created_at = NOW() - INTERVAL '31 days' WHERE id = ${old}`;
    const late = await attachReferralCode(old, 'attach-ref-h');
    assert(late.ok === false && late.reason === 'too-late', 'not after 30 days');
    void wsJoiner;

    console.log('\n[11] webhook never throws when Apple is unconfigured; weeks bank with a note');
    unconfigureApple();
    const refI = await mkUser('refI');
    const wsI = await mkWorkspace(refI);
    await makeApplePaying(wsI, 'apple_txn_refI');
    await setCode(refI, 'apple-ref-i');
    const feeI = await mkUser('feeI');
    const wsFeeI = await mkWorkspace(feeI);
    await recordReferralSignup({ referredUserId: feeI, rawCode: 'apple-ref-i' });
    appleCalls = [];
    const unconf = await appleTrialThenConvert(wsFeeI, 'apple_txn_feeI');
    assert(unconf.statusCode === 200 && unconf.body?.received === true, 'webhook returns 200');
    assert(appleCalls.length === 0, 'no Apple call attempted');
    const ledI = await ledgerFor(wsI);
    const ledFeeI = await ledgerFor(wsFeeI);
    assert(ledI.length === 1 && !ledI[0].applied_at && ledI[0].note === 'apple-not-configured', 'referrer week banked with note');
    assert(ledFeeI.length === 0, 'no ledger row for the referred owner');
    const statusI = (await sql`SELECT subscription_status, converted_at FROM workspaces WHERE id = ${wsFeeI}`).rows[0];
    assert(statusI.subscription_status === 'active' && statusI.converted_at, 'subscription state still flipped');
    // Apple rejecting the call also leaves the row banked with the reason.
    configureApple();
    appleShouldFail = true; appleCalls = [];
    const rej = await applyBankedAppleWeeks(wsI);
    assert(rej.reason === 'apple-failed' && rej.appliedWeeks === 0, 'Apple failure → apple-failed, nothing applied');
    const ledI2 = await ledgerFor(wsI);
    assert(!ledI2[0].applied_at && /4000030/.test(ledI2[0].note) && ledI2[0].apple_request_id === null, 'row stays unapplied with the Apple error in note, claim released');
    appleShouldFail = false; appleCalls = [];
    const retry = await grantPendingReferralCredits(refI);
    assert(retry.appliedWeeks === 1 && appleCalls.length === 1, 'next sweep delivers it');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    unconfigureApple();
    await sql`DELETE FROM webhook_event_dedup WHERE provider = 'revenuecat' AND event_id LIKE 'rc_evt_%'`.catch(() => {});
    for (const id of created.users) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
    globalThis.fetch = realFetch;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
