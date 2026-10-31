// A referral pays out only when the referred owner's first real payment
// lands, never on the $0 invoice Stripe marks "paid" when a free trial
// starts. Fires signed Stripe events at the real billing webhook.
// Run: node --import ./tests/bootstrap.mjs ./tests/referral-first-payment.test.mjs
import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';

const WEBHOOK_SECRET = 'whsec_test_ref_first_pay';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_platform';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.RESEND_API_KEY ||= 're_test_not_real';

const { default: billing } = await import('../api/webhooks/billing.js');
const { recordReferralSignup, setCode } = await import('../api/_lib/referrals.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

// Stripe API mock: subscription lookups + customer-balance credits.
const credits = [];
let subStatus = 'trialing';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('/v1/subscriptions/')) {
    return json({ id: `sub_friend_${S}`, status: subStatus, customer: `cus_friend_${S}`, current_period_end: Math.floor(Date.now() / 1000) + 7 * 86400, items: { data: [{ price: { id: 'price_x', unit_amount: 899, recurring: { interval: 'week' } } }] }, metadata: {} });
  }
  if (u.includes('/balance_transactions')) { credits.push({ url: u, body: String(init.body || '') }); return json({ id: `cbtxn_${credits.length}`, amount: -899 }); }
  return json({});
};
function signedReq(event) {
  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return { method: 'POST', url: '/api/webhooks/billing', body: payload, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } };
}
const mkRes = () => ({ statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, json(o) { this.body = o; return this; }, end(s) { this.body = s; return this; } });
const invoiceEvent = (n, amountPaid) => ({ id: `evt_inv_${S}_${n}`, type: 'invoice.payment_succeeded', data: { object: { id: `in_${S}_${n}`, subscription: `sub_friend_${S}`, amount_paid: amountPaid, amount_due: amountPaid, currency: 'usd', billing_reason: n === 1 ? 'subscription_create' : 'subscription_cycle' } } });

async function main() {
  await ensureSchemaApplied();
  // Referrer: an active Stripe subscriber with a code.
  const ref = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`referrer-${S}@example.com`}, 'x', 'Ref', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_source, subscription_period_end, stripe_customer_id, stripe_subscription_id, converted_at, onboarded_at)
            VALUES (${ref}, 'Ref WS', 'active', 'stripe', NOW() + INTERVAL '6 days', ${`cus_ref_${S}`}, ${`sub_ref_${S}`}, NOW() - INTERVAL '30 days', NOW())`;
  const code = `R${String(S).slice(-6)}`;
  await setCode(ref, code);
  // Friend: signs up with the code and starts a web trial.
  const friend = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`friend-${S}@example.com`}, 'x', 'Friend', NOW()) RETURNING id`).rows[0].id;
  const fws = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_source, stripe_customer_id, stripe_subscription_id, trial_ends_at, trial_started_at, onboarded_at)
            VALUES (${friend}, 'Friend WS', 'trialing', 'stripe', ${`cus_friend_${S}`}, ${`sub_friend_${S}`}, NOW() + INTERVAL '14 days', NOW(), NOW()) RETURNING id`).rows[0].id;
  const rec = await recordReferralSignup({ referredUserId: friend, rawCode: code });
  assert(!!rec, 'invite link code attached at sign-up');
  const referral = async () => (await sql`SELECT converted_at, rewarded_at FROM referrals WHERE referred_user_id = ${friend}`).rows[0];

  console.log('\n[1] trial starts: Stripe sends a $0 "paid" invoice');
  let r = mkRes(); await billing(signedReq(invoiceEvent(1, 0)), r);
  assert(r.statusCode === 200, `webhook 200 (${JSON.stringify(r.body)})`);
  assert(!(await referral()).converted_at, 'referral NOT converted by the $0 trial invoice');
  assert(credits.length === 0, 'referrer NOT credited yet');
  const w1 = (await sql`SELECT converted_at, subscription_status FROM workspaces WHERE id = ${fws}`).rows[0];
  assert(!w1.converted_at, 'friend not marked as having paid');

  console.log('\n[2] trial ends: the first real $8.99 charge');
  subStatus = 'active';
  r = mkRes(); await billing(signedReq(invoiceEvent(2, 899)), r);
  assert(r.statusCode === 200, 'webhook 200');
  assert(!!(await referral()).converted_at, 'referral converted on the first real payment');
  assert(credits.length === 1 && credits[0].url.includes(`cus_ref_${S}`) && /amount=-899/.test(credits[0].body), `referrer credited one free week (-$8.99) on their own customer (${credits.length})`);
  const w2 = (await sql`SELECT converted_at FROM workspaces WHERE id = ${fws}`).rows[0];
  assert(!!w2.converted_at, 'friend now marked as having paid');

  console.log('\n[3] the next weekly charge does not reward again');
  r = mkRes(); await billing(signedReq(invoiceEvent(3, 899)), r);
  assert(credits.length === 1, 'still exactly one credit');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
