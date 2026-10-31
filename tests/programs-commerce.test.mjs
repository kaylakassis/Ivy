// Programs phase 3 commerce: free trials, coupons, bundles and cohort
// checkout, through the real handlers against local Postgres. Stripe is
// mocked by replacing globalThis.fetch (every call recorded); webhooks
// arrive as real signed payloads.
//
//   [1] trials: checkout params, access while trialing, one trial per email,
//       trial ending unpaid closes access, never counted as revenue
//   [2] coupons: owner CRUD + payment-account coupon, public check (same
//       answer for every failure, rate limited), discount on checkout,
//       expiry, max redemptions, switch-off, redemptions counted once,
//       what was actually paid is stored and counted
//   [3] bundles: included package granted once per session, add-on second
//       line item, revenue counted exactly once, refunds take the credits
//   [4] cohort checkout
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/programs-commerce.test.mjs
import crypto from 'node:crypto';

process.env.STRIPE_SECRET_KEY = 'sk_test_commerce';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_commerce';
process.env.SECRETS_KEY = process.env.SECRETS_KEY || 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import programsIndex from '../api/programs/index.js';
import programById from '../api/programs/[id].js';
import programPublic from '../api/programs/public/[id].js';
import programCheckout from '../api/programs/checkout.js';
import programCoupons from '../api/programs/coupons.js';
import couponCheck from '../api/programs/coupon-check.js';
import programCohorts from '../api/programs/[id]/cohorts.js';
import programRefund from '../api/programs/refund.js';
import packageRefund from '../api/packages/refund.js';
import meProgram from '../api/me/programs/[id].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Stripe + Resend mock ─────────────────────────────────────────────
const calls = [];
let seq = 0;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const method = (init.method || 'GET').toUpperCase();
  if (/api\.resend\.com/.test(u)) return json({ id: 'em' });
  const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  calls.push({ url: u, method, body, headers: init.headers || {} });
  if (/\/v1\/customers\?/.test(u) && method === 'GET') return json({ data: [] });
  if (/\/v1\/customers$/.test(u) && method === 'POST') return json({ id: `cus_${++seq}` });
  if (/\/v1\/coupons$/.test(u) && method === 'POST') return json({ id: `co_${++seq}`, ...body });
  if (/\/v1\/coupons\/[^/]+$/.test(u) && method === 'DELETE') return json({ id: u.split('/').pop(), deleted: true });
  if (/\/v1\/checkout\/sessions$/.test(u) && method === 'POST') return json({ id: `cs_${++seq}`, url: `https://checkout.stripe.com/c/${seq}` });
  if (/\/refunds$/.test(u)) return json({ id: `re_${++seq}`, amount: Number(body.amount || 0), status: 'succeeded' });
  return json({});
};
const stripeCalls = (re) => calls.filter((c) => re.test(`${c.method} ${c.url}`));
const lastCheckout = () => stripeCalls(/POST .*\/v1\/checkout\/sessions$/).at(-1);

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
const HOST = 'www.joinivy.ai';
const IPB = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
let ipN = 10;
function req({ method = 'GET', cookie, query = {}, body, ip } = {}) {
  return { method, url: '/t', query, body,
    headers: { 'content-type': 'application/json', host: HOST, origin: `https://${HOST}`, 'x-forwarded-for': ip || `${IPB}.${ipN++ % 250}`, 'user-agent': 'test', ...(cookie ? { cookie } : {}) } };
}
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }
const cookieFor = (uid) => `ivy_session=${signSession(uid)}`;
let evtN = 0;
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_pcm_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}

const STAMP = Date.now();
const T = `pcm${STAMP}`;
const users = [];
async function mkOwner(label) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`${T}-${label}@example.com`}, 'x', ${`${label} Owner`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone) VALUES (${wid}, ${`${label} Studio`}, ${`${T}-${label}`}, 'America/New_York')
    ON CONFLICT (workspace_id) DO UPDATE SET biz_name = ${`${label} Studio`}`;
  const acct = `acct_${T}_${label}`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency) VALUES (${wid}, ${acct}, 'complete', 'USD')`;
  users.push(u);
  return { uid: u, wid, acct, cookie: cookieFor(u) };
}
const cents = (v) => Math.round(Number(v) * 100);
const rev = async (wid) => (await sql`SELECT * FROM workspace_revenue WHERE workspace_id = ${wid}`).rows[0];
const clientByEmail = async (wid, email) => (await sql`SELECT * FROM clients WHERE workspace_id = ${wid} AND LOWER(email) = ${email.toLowerCase()}`).rows[0];
const subObj = (id, md, over = {}) => ({
  id, object: 'subscription', status: 'active', cancel_at_period_end: false, metadata: md,
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, customer: 'cus_x', items: { data: [{ id: 'si_1', price: { id: 'price_inline' } }] }, ...over,
});

async function run() {
  await ensureSchemaApplied();
  const A = await mkOwner('alpha');
  const B = await mkOwner('beta');
  const mk = async (owner, body) => {
    const r = await call(programsIndex, req({ method: 'POST', cookie: owner.cookie, body }));
    await call(programById, req({ method: 'PATCH', cookie: owner.cookie, query: { id: r.body.program.id }, body: { status: 'published' } }));
    return r.body.program;
  };

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[1] free trials');
  let r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'X', priceCents: 1000, billing: 'month', trialDays: 45 } }));
  assert(r.statusCode === 400 && /trial/i.test(r.body.error), 'trial over 30 days → 400');
  const sub = await mk(A, { title: `Circle ${T}`, priceCents: 2900, billing: 'month', trialDays: 14 });
  assert(sub.trialDays === 14, 'monthly program with a 14-day trial');
  const once = await mk(A, { title: `Course ${T}`, priceCents: 9900, billing: 'one_time', trialDays: 7 });
  assert(once.trialDays === null, 'a one-time program never has a trial');
  r = await call(programPublic, req({ query: { id: sub.id } }));
  assert(r.body.trialDays === 14, 'sales page knows about the trial');
  const t1 = `trial-one-${T}@example.com`;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: sub.id, name: 'Tia', email: t1 } }));
  let cs = lastCheckout();
  assert(r.statusCode === 200 && r.body.trialApplied === true && r.body.trialDays === 14, 'checkout offers the trial');
  assert(cs.body['subscription_data[trial_period_days]'] === '14' && cs.body['subscription_data[trial_settings][end_behavior][missing_payment_method]'] === 'cancel', 'trial_period_days + cancel when no card at trial end');
  const tc = await clientByEmail(A.wid, t1);
  const md = { workspace_id: A.wid, program_id: sub.id, client_id: tc.id, purpose: 'program', trial: '1' };
  const trialEnd = Math.floor(Date.now() / 1000) + 14 * 86400;
  r = await fire('customer.subscription.created', subObj('sub_trial_1', md, { status: 'trialing', trial_end: trialEnd }), A.acct);
  assert(r.statusCode === 200 && r.body.applied === 'program-subscription', 'trialing subscription applied');
  let e = (await sql`SELECT * FROM program_enrollments WHERE stripe_subscription_id = 'sub_trial_1'`).rows[0];
  assert(e?.status === 'active' && e.trialing === true && Math.abs(new Date(e.trial_ends_at).getTime() / 1000 - trialEnd) < 2, 'access during the trial, marked as trialing');
  assert((await sql`SELECT 1 FROM program_trials WHERE program_id = ${sub.id} AND email = ${t1}`).rows.length === 1, 'the trial is recorded against the email');
  let rv = await rev(A.wid);
  assert(Number(rv.programs) === 0 && Number(rv.total) === 0, 'a trialing subscription is not revenue');
  const tcUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${t1}, 'x', 'Tia', NOW()) RETURNING id`).rows[0].id;
  users.push(tcUser);
  await sql`UPDATE clients SET user_id = ${tcUser} WHERE id = ${tc.id}`;
  r = await call(meProgram, req({ cookie: cookieFor(tcUser), query: { id: sub.id } }));
  assert(r.statusCode === 200 && r.body.trialEndsAt, 'member can open the program during the trial and sees when it ends');
  // Same email again (any case): full price, no trial.
  r = await call(programCheckout, req({ method: 'POST', body: { programId: sub.id, name: 'Tia', email: t1.toUpperCase() } }));
  cs = lastCheckout();
  assert(r.statusCode === 200 && r.body.trialApplied === false && r.body.trialUsed === true && !('subscription_data[trial_period_days]' in cs.body), 'one trial per email: the second checkout is full price');
  // Someone who was a member before (no trial row) gets no trial either.
  const past = `past-${T}@example.com`;
  const pc = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${A.wid}, 'Past', ${past}, 'active') RETURNING id`).rows[0].id;
  await sql`INSERT INTO program_enrollments (program_id, workspace_id, client_id, source, status, billing) VALUES (${sub.id}, ${A.wid}, ${pc}, 'subscription', 'cancelled', 'month')`;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: sub.id, name: 'Past', email: past } }));
  assert(r.body.trialApplied === false && r.body.trialUsed === true, 'a former member gets no trial');
  r = await call(programCheckout, req({ method: 'POST', body: { programId: sub.id, name: 'New', email: `fresh-${T}@example.com` } }));
  assert(r.body.trialApplied === true, 'a new email still gets the trial');
  // Trial converts → paid, no longer trialing.
  r = await fire('customer.subscription.updated', subObj('sub_trial_1', md, { status: 'active' }), A.acct);
  e = (await sql`SELECT * FROM program_enrollments WHERE stripe_subscription_id = 'sub_trial_1'`).rows[0];
  assert(e.status === 'active' && e.trialing === false, 'trial converted: active and no longer trialing');
  // Trial that ends unpaid: canceled (no card) or incomplete_expired.
  const t2 = `trial-two-${T}@example.com`;
  await call(programCheckout, req({ method: 'POST', body: { programId: sub.id, name: 'Two', email: t2 } }));
  const tc2 = await clientByEmail(A.wid, t2);
  const md2 = { ...md, client_id: tc2.id };
  await fire('customer.subscription.created', subObj('sub_trial_2', md2, { status: 'trialing', trial_end: trialEnd }), A.acct);
  r = await fire('customer.subscription.deleted', subObj('sub_trial_2', md2, { status: 'canceled' }), A.acct);
  e = (await sql`SELECT * FROM program_enrollments WHERE stripe_subscription_id = 'sub_trial_2'`).rows[0];
  assert(e.status === 'cancelled' && e.trialing === false, 'trial ended with no payment → access closed');
  const t3 = `trial-three-${T}@example.com`;
  await call(programCheckout, req({ method: 'POST', body: { programId: sub.id, name: 'Three', email: t3 } }));
  const tc3 = await clientByEmail(A.wid, t3);
  const md3 = { ...md, client_id: tc3.id };
  await fire('customer.subscription.created', subObj('sub_trial_3', md3, { status: 'trialing', trial_end: trialEnd }), A.acct);
  await fire('customer.subscription.updated', subObj('sub_trial_3', md3, { status: 'incomplete_expired' }), A.acct);
  e = (await sql`SELECT * FROM program_enrollments WHERE stripe_subscription_id = 'sub_trial_3'`).rows[0];
  assert(e.status === 'cancelled', 'incomplete_expired after a trial → access closed');
  rv = await rev(A.wid);
  assert(Number(rv.programs) === 0, 'subscriptions (trial or not) are never counted as one-time revenue');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[2] coupons');
  const other = await mk(A, { title: `Other ${T}`, priceCents: 5000, billing: 'one_time' });
  r = await call(programCoupons, req({ method: 'POST', cookie: A.cookie, body: { code: 'x', kind: 'percent', percentOff: 10 } }));
  assert(r.statusCode === 400, 'too-short code → 400');
  r = await call(programCoupons, req({ method: 'POST', cookie: A.cookie, body: { code: 'NOPE', kind: 'percent', percentOff: 101 } }));
  assert(r.statusCode === 400, 'percent over 100 → 400');
  r = await call(programCoupons, req({ method: 'POST', cookie: A.cookie, body: { code: 'OLD', kind: 'percent', percentOff: 10, expiresAt: '2020-01-01' } }));
  assert(r.statusCode === 400, 'expiry in the past → 400');
  r = await call(programCoupons, req({ method: 'POST', cookie: A.cookie, body: { code: 'XB1', kind: 'percent', percentOff: 10, programId: (await mk(B, { title: 'B one', priceCents: 100 })).id } }));
  assert(r.statusCode === 404, "a code for another business's program → 404");
  calls.length = 0;
  const code1 = `SAVE20${STAMP % 100000}`;
  r = await call(programCoupons, req({ method: 'POST', cookie: A.cookie, body: { code: code1.toLowerCase(), kind: 'percent', percentOff: 20, programId: once.id, maxRedemptions: 2 } }));
  assert(r.statusCode === 201 && r.body.coupon.code === code1 && r.body.coupon.programId === once.id, 'owner creates a 20% code for one program (stored upper case)');
  const C1 = r.body.coupon;
  const made = stripeCalls(/POST .*\/v1\/coupons$/).at(-1);
  assert(made && made.headers['Stripe-Account'] === A.acct && made.body.percent_off === '20' && made.body.duration === 'once' && made.body.max_redemptions === '2' && made.headers['Idempotency-Key'], "the same coupon is created on the business's own payment account");
  r = await call(programCoupons, req({ method: 'POST', cookie: A.cookie, body: { code: code1, kind: 'percent', percentOff: 5 } }));
  assert(r.statusCode === 400, 'duplicate active code → 400');
  const code2 = `TENOFF${STAMP % 100000}`;
  r = await call(programCoupons, req({ method: 'POST', cookie: A.cookie, body: { code: code2, kind: 'amount', amountOffCents: 1000, duration: 'forever' } }));
  const C2 = r.body.coupon;
  assert(r.statusCode === 201 && C2.programId === null && C2.duration === 'forever', 'a $10 off code for every program, forever on subscriptions');
  const codeB = `BONLY${STAMP % 100000}`;
  await call(programCoupons, req({ method: 'POST', cookie: B.cookie, body: { code: codeB, kind: 'percent', percentOff: 50 } }));
  r = await call(programCoupons, req({ cookie: B.cookie }));
  assert(!r.body.coupons.some((c) => c.code === code1), "B cannot see A's codes");
  // Public check.
  r = await call(couponCheck, req({ method: 'POST', body: { programId: once.id, code: code1.toLowerCase() } }));
  assert(r.statusCode === 200 && r.body.valid && r.body.discountCents === 1980 && r.body.priceAfterCents === 7920, '20% off $99 → $79.20');
  r = await call(couponCheck, req({ method: 'POST', body: { programId: other.id, code: code1 } }));
  const wrongProgram = r.body.error;
  assert(r.statusCode === 400 && wrongProgram === "This code isn't valid for this program.", 'per-program code on another program → generic answer');
  r = await call(couponCheck, req({ method: 'POST', body: { programId: once.id, code: 'DOESNOTEXIST' } }));
  assert(r.statusCode === 400 && r.body.error === wrongProgram, 'unknown code → the very same answer');
  r = await call(couponCheck, req({ method: 'POST', body: { programId: once.id, code: codeB } }));
  assert(r.statusCode === 400 && r.body.error === wrongProgram, "another business's code → the very same answer");
  r = await call(couponCheck, req({ method: 'POST', body: { programId: other.id, code: code2 } }));
  assert(r.statusCode === 200 && r.body.discountCents === 1000, 'all-programs code works on any of them');
  const ipRL = `${IPB}.251`;
  let last;
  for (let i = 0; i < 21; i++) last = await call(couponCheck, req({ method: 'POST', body: { programId: once.id, code: 'GUESS' + i }, ip: ipRL }));
  assert(last.statusCode === 429, 'code checks are rate limited');
  // Checkout with the code.
  const buyer = `buyer-${T}@example.com`;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: once.id, name: 'Bea', email: buyer, couponCode: 'nope-nope' } }));
  assert(r.statusCode === 400 && r.body.error === wrongProgram, 'checkout with a bad code → 400, nothing created');
  r = await call(programCheckout, req({ method: 'POST', body: { programId: once.id, name: 'Bea', email: buyer, couponCode: code1 } }));
  cs = lastCheckout();
  assert(r.statusCode === 200 && r.body.couponApplied && !!cs.body['discounts[0][coupon]'] && cs.body['metadata[coupon_id]'] === C1.id, 'checkout carries discounts[0][coupon] and the coupon id');
  const stripeCouponId = (await sql`SELECT stripe_coupon_id FROM program_coupons WHERE id = ${C1.id}`).rows[0].stripe_coupon_id;
  assert(cs.body['discounts[0][coupon]'] === stripeCouponId && cs.body['line_items[0][price_data][unit_amount]'] === '9900', 'the payment-account coupon is applied to the full price line');
  const bc = await clientByEmail(A.wid, buyer);
  const paidSession = (id, over = {}) => ({
    id, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 7920, total_details: { amount_discount: 1980 }, payment_intent: `pi_${id}`,
    metadata: { workspace_id: A.wid, program_id: once.id, client_id: bc.id, purpose: 'program', coupon_id: C1.id }, ...over,
  });
  r = await fire('checkout.session.completed', paidSession(`cs_cp1_${T}`), A.acct);
  assert(r.body.applied === 'program-purchase', 'discounted purchase fulfilled');
  e = (await sql`SELECT * FROM program_enrollments WHERE stripe_session_id = ${`cs_cp1_${T}`}`).rows[0];
  assert(e.price_cents === 7920 && e.discount_cents === 1980 && e.coupon_id === C1.id, 'the enrollment stores what was actually paid, the discount and the code');
  await fire('checkout.session.completed', paidSession(`cs_cp1_${T}`), A.acct);
  assert((await sql`SELECT COUNT(*)::int AS n FROM program_coupon_redemptions WHERE coupon_id = ${C1.id}`).rows[0].n === 1, 'a replayed webhook counts the redemption once');
  rv = await rev(A.wid);
  assert(Number(rv.programs) === 79.2, `revenue counts the $79.20 actually paid (${rv.programs})`);
  r = await call(programById, req({ cookie: A.cookie, query: { id: once.id } }));
  const mem = r.body.members.find((m) => m.clientId === bc.id);
  assert(mem?.couponCode === code1 && mem.discountCents === 1980 && mem.priceCents === 7920 && mem.refundable, 'owner sees the code used and can refund what was paid');
  // Max redemptions: 2. Second use fills it up.
  const buyer2 = `buyer2-${T}@example.com`;
  await call(programCheckout, req({ method: 'POST', body: { programId: once.id, name: 'Bo', email: buyer2, couponCode: code1 } }));
  const bc2 = await clientByEmail(A.wid, buyer2);
  await fire('checkout.session.completed', paidSession(`cs_cp2_${T}`, { metadata: { workspace_id: A.wid, program_id: once.id, client_id: bc2.id, purpose: 'program', coupon_id: C1.id } }), A.acct);
  r = await call(couponCheck, req({ method: 'POST', body: { programId: once.id, code: code1 } }));
  assert(r.statusCode === 400 && r.body.error === wrongProgram, 'used up → same answer');
  r = await call(programCheckout, req({ method: 'POST', body: { programId: once.id, name: 'Cy', email: `cy-${T}@example.com`, couponCode: code1 } }));
  assert(r.statusCode === 400, 'used up → refused at checkout too');
  // Expiry.
  await sql`UPDATE program_coupons SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${C2.id}`;
  r = await call(couponCheck, req({ method: 'POST', body: { programId: other.id, code: code2 } }));
  assert(r.statusCode === 400 && r.body.error === wrongProgram, 'expired → same answer');
  await sql`UPDATE program_coupons SET expires_at = NULL WHERE id = ${C2.id}`;
  // Subscription with a forever code: metadata rides on the subscription; redemption once per subscription.
  const sb = `sub-coupon-${T}@example.com`;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: sub.id, name: 'Sub', email: sb, couponCode: code2 } }));
  cs = lastCheckout();
  assert(cs.body['subscription_data[metadata][coupon_id]'] === C2.id && cs.body['discounts[0][coupon]'], 'subscription checkout carries the code on the subscription too');
  const sc = await clientByEmail(A.wid, sb);
  const smd = { workspace_id: A.wid, program_id: sub.id, client_id: sc.id, purpose: 'program', coupon_id: C2.id };
  await fire('customer.subscription.created', subObj(`sub_cp_${T}`, smd), A.acct);
  await fire('customer.subscription.updated', subObj(`sub_cp_${T}`, smd), A.acct);
  assert((await sql`SELECT COUNT(*)::int AS n FROM program_coupon_redemptions WHERE coupon_id = ${C2.id}`).rows[0].n === 1, 'subscription redemption recorded once');
  const coupStripe = (await sql`SELECT stripe_coupon_id FROM program_coupons WHERE id = ${C2.id}`).rows[0].stripe_coupon_id;
  const c2made = stripeCalls(/POST .*\/v1\/coupons$/).find((c) => c.body['metadata[ivy_coupon_id]'] === C2.id);
  assert(c2made?.body.duration === 'forever' && c2made.body.amount_off === '1000' && c2made.body.currency === 'usd' && !!coupStripe, 'amount-off forever coupon mirrored with currency');
  // Switch a code off.
  r = await call(programCoupons, req({ method: 'PATCH', cookie: B.cookie, body: { couponId: C2.id, active: false } }));
  assert(r.statusCode === 404, 'another business cannot switch it off');
  r = await call(programCoupons, req({ method: 'PATCH', cookie: A.cookie, body: { couponId: C2.id, active: false } }));
  assert(r.statusCode === 200 && stripeCalls(/DELETE .*\/v1\/coupons\//).some((c) => c.url.endsWith(coupStripe)), 'switched off here and removed from the payment account');
  r = await call(couponCheck, req({ method: 'POST', body: { programId: other.id, code: code2 } }));
  assert(r.statusCode === 400 && r.body.error === wrongProgram, 'switched-off code → same answer');
  r = await call(programCoupons, req({ cookie: A.cookie }));
  assert(r.body.coupons.find((c) => c.id === C1.id)?.used === 2, 'owner sees how often a code was used');
  // 100% off: completes with nothing to pay and still grants access.
  const codeFree = `FREE${STAMP % 100000}`;
  r = await call(programCoupons, req({ method: 'POST', cookie: A.cookie, body: { code: codeFree, kind: 'percent', percentOff: 100, programId: other.id } }));
  const CF = r.body.coupon;
  const fb = `free-${T}@example.com`;
  await call(programCheckout, req({ method: 'POST', body: { programId: other.id, name: 'Free', email: fb, couponCode: codeFree } }));
  const fc = await clientByEmail(A.wid, fb);
  r = await fire('checkout.session.completed', { id: `cs_free_${T}`, mode: 'payment', status: 'complete', payment_status: 'no_payment_required', amount_total: 0, total_details: { amount_discount: 5000 }, payment_intent: null, metadata: { workspace_id: A.wid, program_id: other.id, client_id: fc.id, purpose: 'program', coupon_id: CF.id } }, A.acct);
  e = (await sql`SELECT * FROM program_enrollments WHERE stripe_session_id = ${`cs_free_${T}`}`).rows[0];
  assert(r.body.applied === 'program-purchase' && e?.status === 'active' && e.price_cents === 0, '100% off: access granted, $0 recorded');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[3] bundles');
  const pkg = (await sql`INSERT INTO packages (workspace_id, name, session_count, price, expiry_days) VALUES (${A.wid}, 'Five sessions', 5, 120, 90) RETURNING id`).rows[0].id;
  const pkgB = (await sql`INSERT INTO packages (workspace_id, name, session_count, price) VALUES (${B.wid}, 'B pack', 3, 50) RETURNING id`).rows[0].id;
  r = await call(programsIndex, req({ method: 'POST', cookie: A.cookie, body: { title: 'X', priceCents: 100, bundleMode: 'included', bundlePackageId: pkgB } }));
  assert(r.statusCode === 400, "another business's package cannot be attached");
  const inc = await mk(A, { title: `Included ${T}`, priceCents: 9900, bundleMode: 'included', bundlePackageId: pkg });
  assert(inc.bundleMode === 'included' && inc.bundlePackageId === pkg, 'program with an included package');
  const addp = await mk(A, { title: `Addon ${T}`, priceCents: 9900, bundleMode: 'addon', bundlePackageId: pkg });
  const subBundle = await mk(A, { title: `SubBundle ${T}`, priceCents: 900, billing: 'month', bundleMode: 'included', bundlePackageId: pkg });
  assert(subBundle.bundleMode === null, 'subscriptions do not take a bundle');
  r = await call(programPublic, req({ query: { id: addp.id } }));
  assert(r.body.bundle?.mode === 'addon' && r.body.bundle.priceCents === 12000 && r.body.bundle.sessions === 5, 'sales page shows the add-on');
  const ib = `inc-${T}@example.com`;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: inc.id, name: 'Inc', email: ib } }));
  cs = lastCheckout();
  assert(cs.body['metadata[bundle_package_id]'] === pkg && cs.body['metadata[bundle_mode]'] === 'included' && !('line_items[1][price_data][unit_amount]' in cs.body), 'included: one line item, the package rides in metadata');
  const ic = await clientByEmail(A.wid, ib);
  const incSession = { id: `cs_inc_${T}`, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 9900, payment_intent: `pi_inc_${T}`,
    metadata: { workspace_id: A.wid, program_id: inc.id, client_id: ic.id, purpose: 'program', bundle_package_id: pkg, bundle_mode: 'included' } };
  const before = await rev(A.wid);
  r = await fire('checkout.session.completed', incSession, A.acct);
  assert(r.body.bundleGranted === true, 'included package granted');
  r = await fire('checkout.session.completed', incSession, A.acct);
  r = await fire('checkout.session.async_payment_succeeded', incSession, A.acct);
  const incPk = (await sql`SELECT * FROM client_packages WHERE client_id = ${ic.id} AND workspace_id = ${A.wid}`).rows;
  assert(incPk.length === 1 && incPk[0].credits_remaining === 5 && incPk[0].bundle_session_id === incSession.id && incPk[0].program_enrollment_id, 'exactly one package with 5 credits, tied to the purchase');
  assert(!incPk[0].stripe_payment_intent && !incPk[0].stripe_session_id, 'the bundled package has no payment ids of its own');
  let after = await rev(A.wid);
  assert(cents(after.programs) - cents(before.programs) === 9900 && Number(after.packages) === Number(before.packages), 'revenue: $99 once, nothing extra for the included package');
  // Add-on.
  const ab = `add-${T}@example.com`;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: addp.id, name: 'Add', email: ab } }));
  cs = lastCheckout();
  assert(!('line_items[1][price_data][unit_amount]' in cs.body) && cs.body['metadata[bundle_mode]'] === 'addon' && !cs.body['metadata[addon]'], 'add-on not ticked: one line item');
  r = await call(programCheckout, req({ method: 'POST', body: { programId: addp.id, name: 'Add', email: ab, addOn: true } }));
  cs = lastCheckout();
  assert(r.body.addOn === true && cs.body['line_items[1][price_data][unit_amount]'] === '12000' && /Five sessions/.test(cs.body['line_items[1][price_data][product_data][name]']) && cs.body['metadata[addon]'] === '1', 'add-on ticked: second line item for the package');
  const ac = await clientByEmail(A.wid, ab);
  const addSession = { id: `cs_add_${T}`, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 21900, payment_intent: `pi_add_${T}`,
    metadata: { workspace_id: A.wid, program_id: addp.id, client_id: ac.id, purpose: 'program', bundle_package_id: pkg, bundle_mode: 'addon', addon: '1' } };
  const before2 = await rev(A.wid);
  await fire('checkout.session.completed', addSession, A.acct);
  await fire('checkout.session.completed', addSession, A.acct);
  const addPk = (await sql`SELECT * FROM client_packages WHERE client_id = ${ac.id} AND workspace_id = ${A.wid}`).rows;
  e = (await sql`SELECT * FROM program_enrollments WHERE stripe_session_id = ${addSession.id}`).rows[0];
  assert(addPk.length === 1 && Number(addPk[0].price) === 120 && e.price_cents === 21900, 'add-on granted once; the purchase records the whole $219 paid');
  after = await rev(A.wid);
  assert(cents(after.programs) - cents(before2.programs) === 21900 && cents(after.packages) === cents(before2.packages) && cents(after.total) - cents(before2.total) === 21900, 'revenue: $219 counted exactly once');
  // Add-on not chosen at checkout (no addon flag) → no package.
  const nb = `noadd-${T}@example.com`;
  await call(programCheckout, req({ method: 'POST', body: { programId: addp.id, name: 'No', email: nb } }));
  const nc = await clientByEmail(A.wid, nb);
  await fire('checkout.session.completed', { ...addSession, id: `cs_noadd_${T}`, amount_total: 9900, payment_intent: `pi_noadd_${T}`, metadata: { ...addSession.metadata, client_id: nc.id, addon: undefined } }, A.acct);
  assert((await sql`SELECT COUNT(*)::int AS n FROM client_packages WHERE client_id = ${nc.id}`).rows[0].n === 0, 'no add-on chosen → no package');
  // Refunds.
  r = await call(packageRefund, req({ method: 'POST', cookie: A.cookie, body: { id: addPk[0].id } }));
  assert(r.statusCode === 400 && /program purchase/i.test(r.body.error), 'the bundled package cannot be refunded on its own');
  r = await fire('charge.refunded', { id: 'ch_add', payment_intent: addSession.payment_intent, amount: 21900, amount_refunded: 5000 }, A.acct);
  let pk = (await sql`SELECT * FROM client_packages WHERE id = ${addPk[0].id}`).rows[0];
  assert(r.body.result === 'partial' && pk.status === 'active' && pk.credits_remaining === 5, 'partial refund leaves the sessions alone');
  r = await fire('charge.refunded', { id: 'ch_add', payment_intent: addSession.payment_intent, amount: 21900, amount_refunded: 21900 }, A.acct);
  pk = (await sql`SELECT * FROM client_packages WHERE id = ${addPk[0].id}`).rows[0];
  e = (await sql`SELECT * FROM program_enrollments WHERE stripe_session_id = ${addSession.id}`).rows[0];
  assert(r.body.result === 'revoked' && e.status === 'cancelled' && pk.status === 'cancelled' && pk.credits_remaining === 0, 'full refund: access ends and the bundled sessions are cancelled');
  after = await rev(A.wid);
  assert(cents(after.programs) - cents(before2.programs) === 9900, 'a fully refunded bundle counts nothing (only the later $99 purchase without the add-on remains)');
  // In-app refund of the included bundle purchase.
  const incE = (await sql`SELECT id FROM program_enrollments WHERE stripe_session_id = ${incSession.id}`).rows[0].id;
  r = await call(programRefund, req({ method: 'POST', cookie: A.cookie, body: { enrollmentId: incE } }));
  pk = (await sql`SELECT * FROM client_packages WHERE id = ${incPk[0].id}`).rows[0];
  assert(r.statusCode === 200 && r.body.refund.fullyRefunded && pk.status === 'cancelled', 'refund from Ivy cancels the included package too');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[4] cohort checkout');
  const co = await mk(A, { title: `Cohort ${T}`, priceCents: 5000, delivery: 'cohort' });
  const cb = `cohort-${T}@example.com`;
  r = await call(programCheckout, req({ method: 'POST', body: { programId: co.id, name: 'Co', email: cb } }));
  assert(r.statusCode === 400 && /closed/i.test(r.body.error), 'no open cohort → enrollment closed');
  const d = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
  r = await call(programCohorts, req({ method: 'POST', cookie: A.cookie, query: { id: co.id }, body: { name: 'June', startDate: d(20) } }));
  const june = r.body.cohortId;
  r = await call(programCohorts, req({ method: 'POST', cookie: A.cookie, query: { id: co.id }, body: { name: 'May', startDate: d(5), capacity: 10 } }));
  const may = r.body.cohortId;
  r = await call(programPublic, req({ query: { id: co.id } }));
  assert(r.body.cohorts?.map((c) => c.id).join(',') === [may, june].join(',') && r.body.cohorts[0].spotsLeft === 10, 'sales page lists open cohorts, soonest first');
  r = await call(programCheckout, req({ method: 'POST', body: { programId: co.id, name: 'Co', email: cb } }));
  cs = lastCheckout();
  assert(r.statusCode === 200 && cs.body['metadata[cohort_id]'] === may, 'no pick → the next open cohort');
  r = await call(programCheckout, req({ method: 'POST', body: { programId: co.id, name: 'Co', email: cb, cohortId: june } }));
  cs = lastCheckout();
  assert(cs.body['metadata[cohort_id]'] === june, 'buyer picks a cohort');
  const coc = await clientByEmail(A.wid, cb);
  await fire('checkout.session.completed', { id: `cs_co_${T}`, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 5000, payment_intent: `pi_co_${T}`,
    metadata: { workspace_id: A.wid, program_id: co.id, client_id: coc.id, purpose: 'program', cohort_id: june } }, A.acct);
  e = (await sql`SELECT * FROM program_enrollments WHERE stripe_session_id = ${`cs_co_${T}`}`).rows[0];
  assert(e?.cohort_id === june, 'the purchase lands in the picked cohort');
  r = await call(programCheckout, req({ method: 'POST', body: { programId: co.id, name: 'Co', email: cb, cohortId: crypto.randomUUID() } }));
  assert(r.statusCode === 400, 'an unknown cohort is refused');
  // A cohort id from another program in the webhook metadata is ignored.
  const cob = `cohort2-${T}@example.com`;
  await call(programCheckout, req({ method: 'POST', body: { programId: once.id, name: 'X', email: cob } }));
  const cobc = await clientByEmail(A.wid, cob);
  await fire('checkout.session.completed', { id: `cs_cox_${T}`, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 9900, payment_intent: `pi_cox_${T}`,
    metadata: { workspace_id: A.wid, program_id: once.id, client_id: cobc.id, purpose: 'program', cohort_id: june } }, A.acct);
  e = (await sql`SELECT * FROM program_enrollments WHERE stripe_session_id = ${`cs_cox_${T}`}`).rows[0];
  assert(e && e.cohort_id === null, "another program's cohort is never attached");

  // ── cleanup ──
  for (const u of users) await sql`DELETE FROM workspaces WHERE owner_id = ${u}`.catch(() => {});
  for (const u of users) await sql`DELETE FROM users WHERE id = ${u}`.catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
