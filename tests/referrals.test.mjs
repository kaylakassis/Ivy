// Behavior tests for the self-serve referral program ("refer one, get
// one"): code normalization + uniqueness, signup attribution,
// conversion stamping, and the reward-credit grant/sweep logic.
//
// The reward path calls Stripe (applyCustomerCredit → POST
// /customers/.../balance_transactions). We mock global fetch so the
// grant logic runs end-to-end without touching Stripe.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/referrals.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import {
  normalizeCode,
  setCode,
  getCode,
  resolveCodeToReferrer,
  recordReferralSignup,
  markReferralConverted,
  grantPendingReferralCredits,
  getReferralStats,
  REWARD_CENTS,
} from '../api/_lib/referrals.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else      { fail++; console.log('  ✗', label); }
}

const created = { users: [], affiliates: [] };

async function mkUser(label) {
  const r = await sql`
    INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`ref-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`}, 'x', '2026-05-05', NOW())
    RETURNING id
  `;
  const id = r.rows[0].id;
  created.users.push(id);
  return id;
}

// Create a workspace for an owner; optionally active + with a stripe
// customer so they can receive referral credits.
async function mkWorkspace(ownerId, { active = false, customer = null } = {}) {
  const w = await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`;
  if (active || customer) {
    await sql`
      UPDATE workspaces
      SET subscription_status = ${active ? 'active' : 'trialing'},
          stripe_customer_id = ${customer}
      WHERE id = ${w.rows[0].id}
    `;
  }
  return w.rows[0].id;
}

// ── global fetch mock (intercepts the Stripe balance_transactions POST)
const realFetch = globalThis.fetch;
let stripeCalls = [];
let stripeShouldFail = false;
function installFetchMock() {
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/balance_transactions')) {
      stripeCalls.push({ url: String(url), body: opts.body });
      if (stripeShouldFail) {
        return { ok: false, status: 402, json: async () => ({ error: { message: 'card declined' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: 'cbtxn_test', object: 'customer_balance_transaction', amount: -REWARD_CENTS }) };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}
function restoreFetch() { globalThis.fetch = realFetch; }

async function run() {
  installFetchMock();
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';
  try {
    await ensureSchemaApplied();

    console.log('\n[1] normalizeCode');
    assert(normalizeCode('  spring2026 ') === 'SPRING2026', 'trims + uppercases');
    assert(normalizeCode('ab') === null, 'rejects <3 chars');
    assert(normalizeCode('-abc') === null, 'rejects leading dash');
    assert(normalizeCode('good-code') === 'GOOD-CODE', 'allows internal dashes');
    assert(normalizeCode('bad code!') === null, 'rejects punctuation/space-internal');
    assert(normalizeCode('') === null && normalizeCode(null) === null, 'rejects empty/null');

    console.log('\n[2] setCode validation + persistence');
    const owner = await mkUser('owner');
    await mkWorkspace(owner, { active: true, customer: 'cus_owner' });

    const bad = await setCode(owner, 'x');
    assert(bad.ok === false && /3-40/.test(bad.error), 'rejects too-short code with message');
    const blocked = await setCode(owner, 'admin');
    assert(blocked.ok === false && /reserved/i.test(blocked.error), 'rejects denylisted code');

    const okSet = await setCode(owner, 'kayla-vip');
    assert(okSet.ok === true && okSet.code === 'KAYLA-VIP', 'sets + normalizes code');
    assert((await getCode(owner)) === 'KAYLA-VIP', 'getCode reads it back');

    const reSet = await setCode(owner, 'kayla-2026');
    assert(reSet.ok === true && (await getCode(owner)) === 'KAYLA-2026', 'updates existing code (ON CONFLICT)');

    console.log('\n[3] uniqueness across owners + affiliates');
    const owner2 = await mkUser('owner2');
    await mkWorkspace(owner2, { active: true, customer: 'cus_owner2' });
    const clash = await setCode(owner2, 'kayla-2026');
    assert(clash.ok === false && /taken/i.test(clash.error), 'rejects a code another owner already holds');
    // Affiliate-code collision.
    const affOwner = await mkUser('aff-owner');
    const aff = await sql`
      INSERT INTO affiliates (user_id, code, display_name, active)
      VALUES (${affOwner}, 'PARTNERX', 'Partner X', TRUE) RETURNING id
    `;
    created.affiliates.push(aff.rows[0].id);
    const affClash = await setCode(owner2, 'partnerx');
    assert(affClash.ok === false && /taken/i.test(affClash.error), 'rejects a code that collides with an affiliate code');

    console.log('\n[4] resolveCodeToReferrer + recordReferralSignup');
    assert((await resolveCodeToReferrer('kayla-2026')) === owner, 'resolves a set code to its owner');
    assert((await resolveCodeToReferrer('nope-nope')) === null, 'unknown code → null');

    const selfRef = await recordReferralSignup({ referredUserId: owner, rawCode: 'kayla-2026' });
    assert(selfRef.ok === false && selfRef.reason === 'self-referral', 'rejects self-referral');
    const unknown = await recordReferralSignup({ referredUserId: await mkUser('u0'), rawCode: 'does-not-exist' });
    assert(unknown.ok === false && unknown.reason === 'unknown-code', 'unknown code → no-op');

    const referee = await mkUser('referee');
    const rec = await recordReferralSignup({ referredUserId: referee, rawCode: 'kayla-2026' });
    assert(rec.ok === true, 'records a valid referred signup');
    const recAgain = await recordReferralSignup({ referredUserId: referee, rawCode: 'kayla-2026' });
    assert(recAgain.ok === true, 'second record is idempotent (no throw)');
    const cnt = await sql`SELECT COUNT(*)::int AS n FROM referrals WHERE referred_user_id = ${referee}`;
    assert(cnt.rows[0].n === 1, 'exactly one referral row for the referee');

    let stats = await getReferralStats(owner);
    assert(stats.referred === 1 && stats.converted === 0 && stats.rewarded === 0, 'stats: 1 referred, 0 converted/rewarded');

    console.log('\n[5] conversion grants the reward to an ACTIVE referrer');
    stripeCalls = []; stripeShouldFail = false;
    const conv = await markReferralConverted(referee);
    assert(conv.converted === true, 'markReferralConverted stamps conversion');
    assert(stripeCalls.length === 1, 'one Stripe balance credit issued');
    assert((stripeCalls[0].body || '').includes(`amount=-${REWARD_CENTS}`), 'credit body carries the negative reward amount');

    stats = await getReferralStats(owner);
    assert(stats.converted === 1 && stats.rewarded === 1, 'stats: 1 converted, 1 rewarded');
    assert(stats.rewarded_cents === REWARD_CENTS, `rewarded_cents === REWARD_CENTS (${REWARD_CENTS})`);

    console.log('\n[6] grants are idempotent (no double-credit)');
    stripeCalls = [];
    const g = await grantPendingReferralCredits(owner);
    assert(g.granted === 0, 'no pending rewards left to grant');
    assert(stripeCalls.length === 0, 'no second Stripe call');
    const conv2 = await markReferralConverted(referee);
    assert(conv2.converted === false, 'second conversion call is a no-op');

    console.log('\n[7] reward stays PENDING when referrer is not active, then sweeps');
    // Inactive referrer with a code + a converted referee.
    const owner3 = await mkUser('owner3');
    const ws3 = await mkWorkspace(owner3, { active: false, customer: 'cus_owner3' }); // trialing
    await setCode(owner3, 'trial-ref');
    const referee3 = await mkUser('referee3');
    await recordReferralSignup({ referredUserId: referee3, rawCode: 'trial-ref' });
    stripeCalls = [];
    const conv3 = await markReferralConverted(referee3);
    assert(conv3.converted === true, 'conversion stamped even though referrer is trialing');
    assert(stripeCalls.length === 0, 'no credit issued to a non-active referrer');
    let stats3 = await getReferralStats(owner3);
    assert(stats3.converted === 1 && stats3.rewarded === 0, 'reward is pending (converted but not rewarded)');

    // Owner3 becomes active → their own payment sweeps the pending reward.
    await sql`UPDATE workspaces SET subscription_status = 'active' WHERE id = ${ws3}`;
    stripeCalls = [];
    const swept = await grantPendingReferralCredits(owner3);
    assert(swept.granted === 1, 'sweep grants the pending reward once the referrer is active');
    assert(stripeCalls.length === 1, 'one credit issued on the sweep');
    stats3 = await getReferralStats(owner3);
    assert(stats3.rewarded === 1, 'reward now marked rewarded');

    console.log('\n[8] Stripe failure rolls back the claim (retryable)');
    const owner4 = await mkUser('owner4');
    await mkWorkspace(owner4, { active: true, customer: 'cus_owner4' });
    await setCode(owner4, 'flaky-ref');
    const referee4 = await mkUser('referee4');
    await recordReferralSignup({ referredUserId: referee4, rawCode: 'flaky-ref' });
    stripeCalls = []; stripeShouldFail = true;
    const fconv = await markReferralConverted(referee4);
    assert(fconv.converted === true, 'conversion stamped despite Stripe failure');
    let stats4 = await getReferralStats(owner4);
    assert(stats4.converted === 1 && stats4.rewarded === 0, 'no reward recorded after Stripe failure');
    const pendingAfterFail = await sql`
      SELECT rewarded_at, reward_cents FROM referrals WHERE referred_user_id = ${referee4}
    `;
    assert(pendingAfterFail.rows[0].rewarded_at === null && pendingAfterFail.rows[0].reward_cents === null,
      'claim rolled back: rewarded_at + reward_cents are NULL');

    // Now Stripe recovers → a retry sweeps it.
    stripeShouldFail = false; stripeCalls = [];
    const retry = await grantPendingReferralCredits(owner4);
    assert(retry.granted === 1, 'retry grants once Stripe recovers');
    stats4 = await getReferralStats(owner4);
    assert(stats4.rewarded === 1, 'reward recorded after successful retry');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    // Cleanup (referrals + referral_codes cascade off users/workspaces).
    for (const id of created.users) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
    for (const id of created.affiliates) {
      await sql`DELETE FROM affiliates WHERE id = ${id}`.catch(() => {});
    }
    restoreFetch();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
