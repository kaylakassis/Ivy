// Fraud protection 5: card payment limits until Stripe verifies a new
// business (api/_lib/newBusinessLimits.js).
//   [1] the pieces: limits clean-up, reading an amount out of a Stripe
//       call, what "verified" means
//   [2] who is limited: new accounts yes; verified, older (unknown) and
//       non-Connect accounts no; verified is for good
//   [3] the three caps, enforced where every Stripe call goes through,
//       and the refused call never reaches Stripe
//   [4] real checkouts answer in the payer's words; autopay says why
//   [5] the limits lift the moment Stripe verifies the account
//   [6] Admin can see and change the limits; nobody else can
//
// Run: node --import ./tests/bootstrap.mjs ./tests/new-business-limits.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_limits';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_limits';
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.SUPER_ADMIN_EMAIL = `limits-ops-${Date.now()}@example.com`;

import { readFileSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { stripeFetch, chargeOffSession, createSetupCheckoutSession } from '../api/_lib/stripe.js';
import {
  DEFAULT_LIMITS, cleanLimits, describeLimits, stripeCallAmount, isStripeVerified, applyIdentityState,
  previewNewBusinessPayment, enforceNewBusinessPayment, setLimits, getLimits, clearLimitsCache,
  ownerLimitNotice, PAYER_MESSAGE, LIMIT_CODE,
} from '../api/_lib/newBusinessLimits.js';
import { listRiskAccounts } from '../api/_lib/riskHold.js';
import payHandler from '../api/invoice-pay/[token].js';
import stripeInit from '../api/finance/stripe-oauth-init.js';
import stripeDisconnect from '../api/finance/stripe-disconnect.js';
import providersHandler from '../api/finance/payment-providers.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import riskHandler from '../api/admin/risk.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const HOST = 'www.joinivy.ai';
const KEY = process.env.STRIPE_SECRET_KEY;

// Stripe and the email service, faked. `accounts[acct]` is what Stripe
// says about each connected account; `stripeCalls` is every money call
// that actually reached "Stripe".
const accounts = {};
const stripeCalls = [];
let created = 0;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  if (/api\.resend\.com/.test(u)) return json({ id: 'em_1' });
  if (/api\.stripe\.com\/v1\/account$/.test(u)) {
    const a = accounts[init.headers?.['Stripe-Account']];
    if (!a) return json({ error: { message: 'No such account' } }, 404);
    return json({ id: init.headers['Stripe-Account'], charges_enabled: a.charges !== false, payouts_enabled: !!a.payouts, details_submitted: true, livemode: false, email: 'x@example.com',
      requirements: { disabled_reason: a.reason || null, currently_due: a.due || [], past_due: a.pastDue || [] } });
  }
  if (method === 'POST' && /\/v1\/accounts$/.test(u)) return json({ id: `acct_limits_new_${S}_${++created}` });
  if (method === 'POST' && /\/v1\/account_links$/.test(u)) return json({ url: 'https://connect.stripe.com/setup/x', expires_at: Math.floor(Date.now() / 1000) + 300 });
  if (method === 'POST' && /\/v1\/checkout\/sessions$/.test(u)) { stripeCalls.push({ kind: 'checkout', acct: init.headers?.['Stripe-Account'] || null, body: String(init.body) }); return json({ id: `cs_test_${stripeCalls.length}`, url: 'https://checkout.stripe.com/c/pay/x', payment_status: 'unpaid' }); }
  if (method === 'POST' && /\/v1\/payment_intents$/.test(u)) { stripeCalls.push({ kind: 'pi', acct: init.headers?.['Stripe-Account'] || null, body: String(init.body) }); return json({ id: `pi_test_${stripeCalls.length}`, status: 'succeeded', amount: 100 }); }
  return json({});
};

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(c, h = {}) { this.statusCode = c; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; return this; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
let ipN = 1;
const req = ({ method = 'GET', cookie, query = {}, body = {}, headers = {} } = {}) => ({
  method, url: '/t', query, body,
  headers: {
    'content-type': 'application/json', origin: `https://${HOST}`, host: HOST,
    'x-forwarded-for': `198.21.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`, 'user-agent': 'LimitsKit',
    ...(cookie ? { cookie } : {}), ...headers,
  },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }
const cookieFor = (userId) => `ivy_session=${signSession(userId)}`;

async function mkBiz(label, { state = 'unverified', acct = true, userType = 'regular' } = {}) {
  const email = `limits-${label}-${S}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${`Owner ${label}`}, NOW(), ${userType}, '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${`limits-${label}-${S}`})
            ON CONFLICT (workspace_id) DO UPDATE SET slug = ${`limits-${label}-${S}`}`;
  const acctId = acct ? `acct_limits_${label}_${S}` : null;
  if (acct) {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, stripe_identity_state, currency, payment_provider)
      VALUES (${wid}, ${acctId}, 'complete', ${state}, 'USD', 'stripe')`;
    accounts[acctId] = { payouts: state === 'verified' };
  }
  return { u, wid, email, acctId, cookie: cookieFor(u) };
}
const pay = (acct, cents) => stripeFetch('/payment_intents', { method: 'POST', secretKey: KEY, stripeAccount: acct, body: { amount: cents, currency: 'usd' } });
const checkout = (acct, cents, extra = {}) => stripeFetch('/checkout/sessions', { method: 'POST', secretKey: KEY, stripeAccount: acct,
  body: { mode: 'payment', 'line_items[0][price_data][unit_amount]': cents, 'line_items[0][quantity]': 1, ...extra } });
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const events = async (wid, kind) => (await sql`SELECT detail FROM risk_events WHERE workspace_id = ${wid} AND kind = ${kind}`).rows.map((r) => r.detail);
let evtN = 0;
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_limits_${S}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}

async function run() {
  await ensureSchemaApplied();
  await sql`UPDATE app_settings SET new_business_limits = NULL WHERE id = 1`;
  clearLimitsCache();

  console.log('\n[1] the pieces');
  assert(DEFAULT_LIMITS.enabled && DEFAULT_LIMITS.maxPaymentCents === 50000 && DEFAULT_LIMITS.maxDailyCount === 10 && DEFAULT_LIMITS.maxDailyCents === 150000, 'defaults: $500 a payment, 10 payments and $1,500 in 24 hours');
  assert(describeLimits(DEFAULT_LIMITS) === 'up to $500 per card payment, 10 card payments in 24 hours, and $1,500 in total in 24 hours', `plain words: ${describeLimits(DEFAULT_LIMITS)}`);
  const c = cleanLimits({ maxPaymentCents: -5, maxDailyCount: 99999, maxDailyCents: 'abc', enabled: 'yes', extra: 1 });
  assert(c.maxPaymentCents === 100 && c.maxDailyCount === 500 && c.maxDailyCents === 150000 && c.enabled === true && !('extra' in c), 'nonsense settings are clamped or ignored');
  assert(stripeCallAmount('/payment_intents', { amount: 2000 }) === 2000, 'saved-card charge: the amount');
  assert(stripeCallAmount('/checkout/sessions', { mode: 'payment', 'line_items[0][price_data][unit_amount]': 2500, 'line_items[0][quantity]': 2, 'line_items[1][price_data][unit_amount]': '1000', 'line_items[1][quantity]': '1' }) === 6000, 'checkout: every line times its quantity');
  assert(stripeCallAmount('/checkout/sessions', { mode: 'setup' }) === null, 'saving a card (no charge) is not a payment');
  assert(stripeCallAmount('/checkout/sessions', { mode: 'subscription', 'line_items[0][price]': 'price_1' }) === 0, 'a subscription on a saved price counts as a payment of unknown size');
  assert(stripeCallAmount('/refunds', { amount: 500 }) === null && stripeCallAmount('/customers', {}) === null, 'refunds and look-ups are not payments');
  assert(isStripeVerified({ chargesEnabled: true, payoutsEnabled: true, disabledReason: null, requirementsDue: 0 }) === true, 'verified: payments and payouts on, nothing outstanding');
  assert(!isStripeVerified({ chargesEnabled: true, payoutsEnabled: false, requirementsDue: 0 }) && !isStripeVerified({ chargesEnabled: true, payoutsEnabled: true, requirementsDue: 1 })
    && !isStripeVerified({ chargesEnabled: true, payoutsEnabled: true, requirementsDue: 0, disabledReason: 'under_review' }) && !isStripeVerified(null), 'not verified: payouts off, something due, under review, or unknown');

  console.log('\n[2] who is limited');
  const fresh = await mkBiz('fresh');
  const verified = await mkBiz('verified', { state: 'verified' });
  const legacy = await mkBiz('legacy', { state: null });
  const noStripe = await mkBiz('nostripe', { acct: false });
  assert((await previewNewBusinessPayment({ workspaceId: fresh.wid, amountCents: 2000 })).limited === true, 'a new, unverified business is limited');
  assert((await previewNewBusinessPayment({ stripeAccount: fresh.acctId, amountCents: 2000 })).limited === true, '...found by its Stripe account too');
  for (const [b, why] of [[verified, 'a verified business'], [legacy, 'a business from before this rule that Stripe has not been asked about'], [noStripe, 'a business with no Stripe account']]) {
    // eslint-disable-next-line no-await-in-loop
    const v = await previewNewBusinessPayment({ workspaceId: b.wid, amountCents: 9999900 });
    assert(v.ok === true && v.limited === false, `${why} is not limited`);
  }
  assert((await previewNewBusinessPayment({ stripeAccount: 'acct_unknown_to_ivy', amountCents: 9999900 })).limited === false, 'an account Ivy does not know is not limited');
  const settled = await mkBiz('settled', { state: null });
  assert(await applyIdentityState({ workspaceId: settled.wid, summary: { chargesEnabled: true, payoutsEnabled: true, requirementsDue: 1 } }) === 'verified', 'an established business Stripe is already paying out counts as verified, even with a routine request open');
  assert(await applyIdentityState({ workspaceId: legacy.wid, summary: { chargesEnabled: true, payoutsEnabled: false, requirementsDue: 2 } }) === 'unverified', 'asking Stripe about an older account Stripe is not paying out starts its limits');
  assert(await applyIdentityState({ workspaceId: legacy.wid, summary: { chargesEnabled: true, payoutsEnabled: true, requirementsDue: 0 } }) === 'verified', '...and verifying lifts them');
  assert(await applyIdentityState({ workspaceId: legacy.wid, summary: { chargesEnabled: true, payoutsEnabled: true, requirementsDue: 3 } }) === 'verified', 'once verified, a later routine request from Stripe does not bring the limits back');
  assert(!!(await sql`SELECT stripe_verified_at FROM finance_settings WHERE workspace_id = ${legacy.wid}`).rows[0].stripe_verified_at, 'the date it was verified is kept');

  console.log('\n[3] the three caps, on every Stripe call');
  stripeCalls.length = 0;
  let e = await refused(() => pay(fresh.acctId, 60000));
  assert(e && e.code === LIMIT_CODE && e.status === 403 && e.message === PAYER_MESSAGE && e.reason === 'size', 'a $600 card payment is refused (over $500)');
  assert(stripeCalls.length === 0, '...and never reaches Stripe');
  e = await refused(() => checkout(fresh.acctId, 30000, { 'line_items[0][quantity]': 2 }));
  assert(e && e.reason === 'size', 'a checkout of 2 x $300 is refused the same way');
  assert((await refused(() => pay(fresh.acctId, 50000))) === null && stripeCalls.length === 1 && stripeCalls[0].acct === fresh.acctId, 'exactly $500 goes through');
  // Card testing: small identical charges.
  const tester = await mkBiz('tester');
  let ok = 0;
  for (let i = 0; i < 10; i++) { /* eslint-disable-next-line no-await-in-loop */ if ((await refused(() => checkout(tester.acctId, 2000))) === null) ok++; }
  e = await refused(() => checkout(tester.acctId, 2000));
  assert(ok === 10 && e && e.reason === 'count', 'ten $20 payments in a day go through; the eleventh is refused');
  assert((await events(tester.wid, 'limited_payment')).length === 10 && (await events(tester.wid, 'limit_blocked')).length === 1, 'every attempt is counted once');
  await sql`UPDATE risk_events SET created_at = NOW() - INTERVAL '25 hours' WHERE workspace_id = ${tester.wid} AND kind = 'limited_payment'`;
  assert((await refused(() => checkout(tester.acctId, 2000))) === null, 'a day later the count has reset');
  // Daily total.
  const big = await mkBiz('big');
  assert((await refused(() => pay(big.acctId, 50000))) === null && (await refused(() => pay(big.acctId, 50000))) === null && (await refused(() => pay(big.acctId, 50000))) === null, 'three $500 payments reach the $1,500 daily total');
  e = await refused(() => pay(big.acctId, 100));
  assert(e && e.reason === 'total', 'one more dollar that day is refused');
  // Not payments, and other businesses.
  const before = stripeCalls.length;
  await createSetupCheckoutSession({ secretKey: KEY, stripeAccount: big.acctId, customerId: 'cus_x', workspaceId: big.wid, clientId: null, successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
  assert(stripeCalls.length === before + 1 && (await events(big.wid, 'limited_payment')).length === 3, 'saving a card is allowed and does not count');
  assert((await refused(() => pay(verified.acctId, 5000000))) === null && (await refused(() => checkout(verified.acctId, 5000000))) === null, 'a verified business can take a $50,000 payment');
  assert((await refused(() => stripeFetch('/payment_intents', { method: 'POST', secretKey: KEY, body: { amount: 5000000, currency: 'usd' } }))) === null, "a payment that is not on a connected account (Ivy's own billing) is untouched");
  e = await refused(() => stripeFetch('/checkout/sessions', { method: 'POST', secretKey: KEY, stripeAccount: fresh.acctId, knownAmountCents: 250000, body: { mode: 'subscription', 'line_items[0][price]': 'price_1', 'line_items[0][quantity]': 1 } }));
  assert(e && e.reason === 'size' && /amountCents: Number\(tier\.price_cents\)/.test(readFileSync(new URL('../api/memberships/checkout.js', import.meta.url), 'utf8')), 'a $2,500 membership is refused too (the checkout passes its price along)');
  assert((await refused(() => chargeOffSession({ secretKey: KEY, stripeAccount: fresh.acctId, customerId: 'cus_1', paymentMethodId: 'pm_1', amountCents: 70000, currency: 'usd' })))?.code === LIMIT_CODE, 'charging a saved card goes through the same check');
  const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  assert(/enforceNewBusinessPayment\(/.test(src('../api/gift-cards/checkout.js')) && /enforceNewBusinessPayment\(/.test(src('../api/site/[handle]/checkout.js')), 'the two checkouts that call Stripe directly apply the check themselves');
  const direct = ['../api/gift-cards/checkout.js', '../api/site/[handle]/checkout.js', '../api/finance/stripe-diagnostic.js', '../api/webhooks/stripe-platform.js', '../api/webhooks/stripe/[workspaceId].js', '../api/_lib/stripe.js'];
  const { execSync } = await import('node:child_process');
  const hits = execSync("grep -rl 'api.stripe.com' api --include=*.js", { cwd: new URL('..', import.meta.url).pathname }).toString().trim().split('\n').sort();
  assert(hits.length === direct.length && hits.every((h) => direct.some((d) => d.endsWith(h.replace(/^api\//, '')))), `no other file talks to Stripe directly (${hits.length} known)`);

  console.log('\n[4] real checkouts');
  const mkInvoice = async (b, total) => {
    const raw = crypto.randomBytes(24).toString('hex');
    const id = (await sql`INSERT INTO invoices (workspace_id, client_name, client_email, number, status, items, total, currency, view_token_hash)
      VALUES (${b.wid}, 'Pat', 'pat@example.com', ${`L-${S}-${Math.floor(total)}-${crypto.randomBytes(2).toString('hex')}`}, 'sent', ${JSON.stringify([{ description: 'x', quantity: 1, rate: total }])}::jsonb, ${total}, 'USD', ${crypto.createHash('sha256').update(raw).digest('hex')}) RETURNING id`).rows[0].id;
    return { raw, id };
  };
  const shop = await mkBiz('shop');
  let inv = await mkInvoice(shop, 800);
  let r = await call(payHandler, req({ method: 'POST', query: { token: inv.raw } }));
  assert(r.statusCode === 403 && r.body.code === LIMIT_CODE && r.body.error === PAYER_MESSAGE, `an $800 invoice cannot be paid by card yet; the payer is told to contact the business (${r.statusCode})`);
  assert(!/limit|verif|fraud|stripe/i.test(r.body.error), 'the payer is not told why');
  inv = await mkInvoice(shop, 120);
  r = await call(payHandler, req({ method: 'POST', query: { token: inv.raw } }));
  assert(r.statusCode === 200 && /checkout\.stripe\.com/.test(r.body.url || r.body.checkoutUrl || ''), `a $120 invoice goes to checkout as normal (${r.statusCode})`);
  inv = await mkInvoice(verified, 8000);
  r = await call(payHandler, req({ method: 'POST', query: { token: inv.raw } }));
  assert(r.statusCode === 200, 'a verified business takes an $8,000 invoice payment');
  const notice = await ownerLimitNotice(shop.wid);
  assert(notice?.active && /up to \$500 per card payment/.test(notice.text) && /lift on their own/.test(notice.text) && !/[–—]/.test(notice.text), 'the owner is told the limits and that they lift on their own');
  assert((await ownerLimitNotice(verified.wid)) === null && (await ownerLimitNotice(noStripe.wid)) === null, 'a verified business sees no notice');
  r = await call(providersHandler, req({ cookie: shop.cookie }));
  assert(r.statusCode === 200 && r.body.providers.stripe.limits?.active === true && r.body.providers.stripe.connected === true, 'Finance gets the notice with the Stripe row');
  r = await call(providersHandler, req({ cookie: verified.cookie }));
  assert(r.statusCode === 200 && r.body.providers.stripe.limits === null, '...and nothing for a verified business');
  assert((await previewNewBusinessPayment({ workspaceId: shop.wid, amountCents: 80000 })).ok === false, 'autopay asks first, so it can say "limited" instead of "declined"');
  assert(/new_business_limit:/.test(src('../src/lib/autopayRules.js')) && /skip\('new_business_limit'\)/.test(src('../api/_lib/autopay.js')), 'autopay has plain words for it');

  console.log('\n[5] the limits lift when Stripe verifies the account');
  accounts[shop.acctId] = { payouts: false, pastDue: ['individual.verification.document'] };
  await fire('account.updated', { id: shop.acctId }, shop.acctId);
  assert((await refused(() => pay(shop.acctId, 80000)))?.code === LIMIT_CODE, 'still waiting on an identity document: still limited');
  accounts[shop.acctId] = { payouts: true };
  await fire('account.updated', { id: shop.acctId }, shop.acctId);
  assert((await sql`SELECT stripe_identity_state FROM finance_settings WHERE workspace_id = ${shop.wid}`).rows[0].stripe_identity_state === 'verified', 'Stripe says verified: recorded');
  assert((await refused(() => pay(shop.acctId, 80000))) === null && (await ownerLimitNotice(shop.wid)) === null, 'the same $800 payment now goes through and the notice is gone');
  // A brand-new connection starts limited; disconnecting clears the state.
  const starter = await mkBiz('starter', { acct: false });
  r = await call(stripeInit, req({ cookie: starter.cookie }));
  const fs1 = (await sql`SELECT stripe_connect_user_id, stripe_identity_state FROM finance_settings WHERE workspace_id = ${starter.wid}`).rows[0];
  assert(r.statusCode === 302 && /connect\.stripe\.com/.test(r.headers.location || '') && fs1?.stripe_identity_state === 'unverified' && /^acct_limits_new_/.test(fs1.stripe_connect_user_id), 'connecting Stripe for the first time starts the business as limited');
  assert((await refused(() => pay(fs1.stripe_connect_user_id, 60000)))?.code === LIMIT_CODE, '...from its very first payment');
  r = await call(stripeDisconnect, req({ method: 'POST', cookie: starter.cookie }));
  const fs2 = (await sql`SELECT stripe_connect_user_id, stripe_identity_state FROM finance_settings WHERE workspace_id = ${starter.wid}`).rows[0];
  assert(fs2.stripe_connect_user_id === null && fs2.stripe_identity_state === null, 'disconnecting Stripe clears it');

  console.log('\n[6] Admin');
  let list = await listRiskAccounts({ limit: 500 });
  const row = list.find((a) => a.workspaceId === tester.wid);
  assert(row?.flags.some((f) => f.id === 'over_limit' && /Tried 1 card payment over the new-business limits/.test(f.label)) && row.paymentsLimited === true, 'a business that hit the limits shows in the risk list');
  assert(!list.find((a) => a.workspaceId === verified.wid), 'a business that never hit them does not');
  r = await call(riskHandler, req({ method: 'POST', cookie: fresh.cookie, body: { action: 'limits', limits: { enabled: false } } }));
  assert((r.statusCode === 403 || r.statusCode === 401) && (await getLimits()).enabled === true, 'a business owner cannot change (or switch off) the limits');
  const ops = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type, terms_version, terms_accepted_at)
    VALUES (${process.env.SUPER_ADMIN_EMAIL}, 'x', 'Ops', NOW(), 'super_admin', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const opsCookie = cookieFor(ops);
  r = await call(riskHandler, req({ cookie: opsCookie }));
  assert(r.statusCode === 200 && r.body.limits.maxPaymentCents === 50000 && /\$500 per card payment/.test(r.body.limitsText), 'the operator sees the current limits');
  r = await call(riskHandler, req({ method: 'POST', cookie: opsCookie, body: { action: 'limits', limits: { maxPaymentCents: 100000, maxDailyCount: 3, maxDailyCents: 99999999999 } } }));
  assert(r.statusCode === 200 && r.body.limits.maxPaymentCents === 100000 && r.body.limits.maxDailyCount === 3 && r.body.limits.maxDailyCents === 20000000 && r.body.limits.enabled === true, 'changes are saved, within sane bounds');
  const lim = await mkBiz('lim');
  assert((await refused(() => pay(lim.acctId, 90000))) === null, 'with a $1,000 cap, $900 goes through');
  assert((await refused(() => pay(lim.acctId, 100))) === null && (await refused(() => pay(lim.acctId, 100))) === null && (await refused(() => pay(lim.acctId, 100)))?.reason === 'count', 'with 3 a day, the fourth is refused');
  r = await call(riskHandler, req({ method: 'POST', cookie: opsCookie, body: { action: 'limits', limits: { enabled: false } } }));
  assert(r.statusCode === 200 && r.body.limits.enabled === false && r.body.limits.maxDailyCount === 3, 'switching them off keeps the numbers');
  assert((await refused(() => pay(lim.acctId, 4000000))) === null && (await ownerLimitNotice(lim.wid)) === null, 'off means off: no caps, no notice');
  const audit = (await sql`SELECT meta FROM audit_events WHERE actor_user_id = ${ops} AND action = 'risk.limits'`).rows;
  assert(audit.length === 2 && audit[0].meta.before && audit[0].meta.after, 'each change is in the audit log with before and after');
  // A direct enforce call reports what it did.
  await setLimits({ enabled: true, ...DEFAULT_LIMITS });
  const v = await enforceNewBusinessPayment({ workspaceId: fresh.wid, amountCents: 1000, kind: 'test' });
  assert(v.ok && v.limited && v.amount === 1000, 'an allowed payment for a limited business is counted');
}

async function cleanup() {
  await sql`UPDATE app_settings SET new_business_limits = NULL WHERE id = 1`.catch(() => {});
  clearLimitsCache();
  await sql`DELETE FROM users WHERE email LIKE ${`limits-%-${S}@%`} OR email = ${process.env.SUPER_ADMIN_EMAIL}`.catch(() => {});
}

run().finally(cleanup).then(() => {
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
