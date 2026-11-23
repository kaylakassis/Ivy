// A saved card is never offered to someone who only typed an email.
//
// Checked against Stripe in test mode (November 2026), on the Stripe-hosted
// page: a payment page created with `customer` offers that customer's cards
// marked allow_redisplay=always ("Pay with .... 4242") and charges one in a
// single click, with no card number or security code. Stripe Checkout in
// setup mode (the automatic payments and "save a card" flows) saved cards
// as "always". A card marked "limited" is not offered and still charges
// off-session exactly as before.
//
// The public booking form takes no sign-in. Its deposit page used to get a
// Stripe customer found BY EMAIL on the business's account. Reproduced with
// the real handler: after the owner deletes a client, Stripe still holds the
// customer and the card; a stranger books with that email and the deposit
// page offers the card.
//
//   [1] the booking form never looks a Stripe customer up by email: a
//       stranger typing a deleted client's email gets a brand-new customer
//   [2] two client records with one email: the record without a card never
//       receives the other record's customer (deposit, card page, request)
//   [3] the client's own customer reaches the deposit page only when Stripe
//       confirms it holds nothing the page would offer; otherwise the
//       deposit is paid with the email alone and no card is kept
//   [4] the card pages opened from the booking form: new customer, card
//       asked to be saved as "limited"
//   [5] every place that records a saved card sets it to "limited" (both
//       webhooks, the automatic payments return, a card kept at payment),
//       skips the write when it already is, and still records the card
//       when Stripe refuses the change
//   [6] a Stripe account that refuses the new setting can still save cards
//   [7] charging a saved card is unchanged
//   [8] one person, one client record: package checkout and the booking
//       form match the email in any letter case
//   [9] the booking form's code cannot quietly go back to an email lookup
//  [10] the backfill script: dry run changes nothing; --apply limits each
//       card once and leaves other tools' cards alone
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/booking-saved-card.test.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.STRIPE_SECRET_KEY = 'sk_test_booking_saved_card';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_booking_saved_card';
process.env.APP_URL ||= 'https://www.joinivy.ai';
process.env.SECRETS_KEY ||= 'a'.repeat(64);

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { encrypt } from '../api/_lib/secrets.js';
import {
  createSetupCheckoutSession, limitSavedCardRedisplay, customerHasNoRedisplayableCard,
  chargeOffSession, SAVED_CARD_REDISPLAY,
} from '../api/_lib/stripe.js';
import { ensureOwnStripeCustomer, storeCardFromPaymentIntent } from '../api/_lib/savedCards.js';
import { cardOnFileCheckout } from '../api/_lib/bookingFees.js';
import { depositCardSetupForRequest } from '../api/_lib/bookingRequests.js';
import { syncSetupSession } from '../api/_lib/autopay.js';
import publicCalendar from '../api/calendar/public/[slug].js';
import packageCheckout from '../api/packages/checkout.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import legacyWebhook from '../api/webhooks/stripe/[workspaceId].js';
import { runBackfill } from '../scripts/limit-saved-card-redisplay.mjs';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const STAMP = Date.now();

// ── A small Stripe: customers, their cards, and what was asked of it ──
// A lookup by email ANSWERS with whoever holds that email, the way Stripe
// does. The booking form must never ask.
const stripe = {
  calls: [], customers: new Map(), pms: new Map(), setupIntents: new Map(), sessions: new Map(), pis: new Map(),
  n: 0, failPmUpdate: false, failCardList: false, cardListHasMore: false, refuseRedisplayParam: false,
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const addCustomer = (id, email) => { stripe.customers.set(id, { id, email }); return id; };
const addCard = (id, customer, allowRedisplay, extra = {}) => {
  stripe.pms.set(id, { id, object: 'payment_method', type: 'card', customer, allow_redisplay: allowRedisplay, card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2034 }, ...extra });
  return id;
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const method = (init.method || 'GET').toUpperCase();
  if (/api\.resend\.com/.test(u)) return json({ id: `em_${++stripe.n}` });
  if (!/api\.stripe\.com/.test(u)) return json({});
  const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
  const p = new URL(u);
  const route = p.pathname.replace(/^\/v1/, '');
  stripe.calls.push({ url: u, method, route, body, headers: init.headers || {} });
  let m;
  if (route === '/customers' && method === 'GET') {
    const email = p.searchParams.get('email');
    return json({ data: [...stripe.customers.values()].filter((c) => c.email === email) });
  }
  if (route === '/customers' && method === 'POST') {
    const id = addCustomer(`cus_new_${++stripe.n}`, body.email);
    return json({ id, email: body.email });
  }
  if ((m = route.match(/^\/customers\/([^/]+)\/payment_methods$/)) && method === 'GET') {
    if (stripe.failCardList) return json({ error: { message: 'Stripe is having a moment' } }, 500);
    return json({ data: [...stripe.pms.values()].filter((pm) => pm.customer === m[1]), has_more: stripe.cardListHasMore });
  }
  if ((m = route.match(/^\/payment_methods\/([^/]+)$/))) {
    const pm = stripe.pms.get(m[1]);
    if (!pm) return json({ error: { message: 'No such PaymentMethod', code: 'resource_missing' } }, 404);
    if (method === 'POST') {
      if (stripe.failPmUpdate) return json({ error: { message: 'Received unknown parameter: allow_redisplay', code: 'parameter_unknown', param: 'allow_redisplay' } }, 400);
      if (body.allow_redisplay) pm.allow_redisplay = body.allow_redisplay;
    }
    return json(pm);
  }
  if (route === '/checkout/sessions' && method === 'POST') {
    if (stripe.refuseRedisplayParam && body['payment_method_data[allow_redisplay]']) {
      return json({ error: { message: 'Received unknown parameter: payment_method_data[allow_redisplay]', code: 'parameter_unknown', param: 'payment_method_data[allow_redisplay]' } }, 400);
    }
    if (body.mode === 'setup' && !body.customer) return json({ error: { message: 'customer missing', param: 'customer' } }, 400);
    const id = `cs_bsc_${++stripe.n}`;
    return json({ id, url: `https://checkout.stripe.com/c/pay/${id}`, customer: body.customer || null });
  }
  if ((m = route.match(/^\/checkout\/sessions\/([^/]+)$/))) return json(stripe.sessions.get(m[1]) || { error: { message: 'No such session' } }, stripe.sessions.has(m[1]) ? 200 : 404);
  if (route === '/setup_intents' && method === 'GET') {
    const mine = [...stripe.setupIntents.values()].filter((si) => (si.account || null) === ((init.headers || {})['Stripe-Account'] || null));
    return json({ data: mine.map((si) => ({ ...si, payment_method: stripe.pms.get(si.payment_method) || null })), has_more: false });
  }
  if ((m = route.match(/^\/setup_intents\/([^/]+)$/))) return json(stripe.setupIntents.get(m[1]) || {});
  if ((m = route.match(/^\/payment_intents\/([^/]+)$/))) return json(stripe.pis.get(m[1]) || {});
  if (route === '/payment_intents' && method === 'POST') return json({ id: `pi_bsc_${++stripe.n}`, status: 'succeeded', amount: Number(body.amount), currency: body.currency });
  return json({});
};
const reset = () => { stripe.calls.length = 0; };
const callsTo = (re) => stripe.calls.filter((c) => re.test(`${c.method} ${c.route}`));
const emailLookups = () => callsTo(/^GET \/customers$/);
const cardWrites = () => callsTo(/^POST \/payment_methods\//);
const lastSession = () => callsTo(/^POST \/checkout\/sessions$/).at(-1);
const flag = (pmId) => stripe.pms.get(pmId)?.allow_redisplay;

// ── request helpers ──────────────────────────────────────────────────
function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, req: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
const HOST = 'www.joinivy.ai';
// Public endpoints are rate limited per IP; a fresh base per run keeps
// repeated local runs from tripping it.
const IPB = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
let ipN = 0;
const post = (body, query = {}) => ({
  method: 'POST', url: '/t', query, body,
  headers: { 'content-type': 'application/json', host: HOST, origin: `https://${HOST}`, 'x-forwarded-for': `${IPB}.${1 + (ipN++ % 200)}`, 'user-agent': 'test' },
});
async function call(handler, r) { const res = mkRes(); res.req = r; await handler(r, res); return res; }

let evtN = 0;
function sign(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;
}
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_bsc_${STAMP}_${++evtN}`, type, account: acct, data: { object } });
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': sign(payload, process.env.STRIPE_WEBHOOK_SECRET), 'content-type': 'application/json' } }, res);
  return res;
}
async function fireLegacy(type, object, workspaceId, secret) {
  const payload = JSON.stringify({ id: `evt_bscl_${STAMP}_${++evtN}`, type, data: { object } });
  const res = mkRes();
  await legacyWebhook({ method: 'POST', url: `/api/webhooks/stripe/${workspaceId}`, query: { workspaceId }, body: payload, headers: { 'stripe-signature': sign(payload, secret), 'content-type': 'application/json' } }, res);
  return res;
}

// ── fixtures ─────────────────────────────────────────────────────────
const ALL_DAY = JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 0, end: 1440 }]])));
async function mkBiz(label, { legacySecret = null } = {}) {
  const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`bsc-${label}-${STAMP}@example.com`}, 'x', ${`${label} Owner`}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `bsc-${label}-${STAMP}`;
  await sql.query(
    `INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, slot_minutes, min_notice_hours, max_advance_days, availability)
     VALUES ($1, $2, $3, 'UTC', 30, 0, 365, $4::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET slug = $3, biz_name = $2, timezone = 'UTC', slot_minutes = 30, min_notice_hours = 0, max_advance_days = 365, availability = $4::jsonb`,
    [wid, `${label} Studio`, slug, ALL_DAY],
  );
  const acct = legacySecret ? null : `acct_bsc_${label}_${STAMP}`;
  if (legacySecret) {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_secret_encrypted, stripe_webhook_secret_encrypted, currency)
      VALUES (${wid}, ${encrypt(`sk_test_bsc_${label}`)}, ${encrypt(legacySecret)}, 'USD')`;
  } else {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency)
      VALUES (${wid}, ${acct}, 'complete', 'USD')`;
  }
  // Deposit $25, late-cancel $40 inside 24h, no-show $30.
  const svcDep = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility, deposit_type, deposit_amount,
      cancellation_fee_amount, cancellation_window_hours, no_show_fee_amount)
    VALUES (${wid}, 'Color', 100, 60, 'public', 'fixed', 25, 40, 24, 30) RETURNING *`).rows[0];
  // Fees, no deposit: the confirmation offers a page to keep a card.
  const svcFee = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility,
      cancellation_fee_amount, cancellation_window_hours, no_show_fee_amount)
    VALUES (${wid}, 'Cut', 60, 60, 'public', 40, 24, 30) RETURNING *`).rows[0];
  const pkg = (await sql`INSERT INTO packages (workspace_id, name, session_count, price, active, visibility)
    VALUES (${wid}, 'Ten Pack', 10, 450, TRUE, 'public') RETURNING id`).rows[0];
  return { uid, wid, slug, acct, svcDep, svcFee, pkg };
}
async function mkClient(wid, email, { customer = null, pm = null, name = 'Avery Client' } = {}) {
  return (await sql`
    INSERT INTO clients (workspace_id, name, email, stage, stripe_customer_id, payment_method_id, payment_method_last4)
    VALUES (${wid}, ${name}, ${email}, 'active', ${customer}, ${pm}, ${pm ? '4242' : null}) RETURNING id`).rows[0].id;
}
const clientRow = (id) => sql`SELECT * FROM clients WHERE id = ${id}`.then((r) => r.rows[0]);
const clientsWith = (wid, email) => sql`SELECT * FROM clients WHERE workspace_id = ${wid} AND LOWER(email) = ${email.toLowerCase()} ORDER BY created_at`.then((r) => r.rows);
const DATE = new Date(Date.now() + 6 * 86400e3).toISOString().slice(0, 10);
let slotN = 0;
// One hour slots, never the same one twice.
const book = (biz, svc, email, name = 'A Stranger') => {
  const startMin = 60 * (slotN++ % 20);
  return call(publicCalendar, post({ serviceId: svc.id, date: DATE, startMin, endMin: startMin + 60, clientName: name, clientEmail: email }, { slug: biz.slug }));
};

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('alpha');
  const L = await mkBiz('legacy', { legacySecret: 'whsec_bsc_legacy' });
  const cleanupUsers = [A.uid, L.uid];

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[1] a stranger books with a deleted client\'s email');
  // The owner deleted the client; Stripe still holds the customer and the
  // card the client saved for automatic payments.
  const goneEmail = `bsc-gone-${STAMP}@example.com`;
  const GONE_CUS = addCustomer(`cus_gone_${STAMP}`, goneEmail);
  addCard(`pm_gone_${STAMP}`, GONE_CUS, 'always');
  reset();
  let r = await book(A, A.svcDep, goneEmail);
  assert(r.statusCode === 201 && /checkout\.stripe\.com/.test(r.body.depositCheckoutUrl || ''), `booking made, deposit page returned (${r.statusCode})`);
  assert(emailLookups().length === 0, 'Stripe is never asked who holds that email');
  let s = lastSession();
  assert(!!s?.body.customer && s.body.customer !== GONE_CUS, 'the deposit page does not get the deleted client\'s customer');
  assert(callsTo(/^POST \/customers$/).length === 1 && s.body.customer === stripe.customers.get(s.body.customer)?.id && /^cus_new_/.test(s.body.customer), 'it gets a customer made for this booking, which holds no cards');
  assert(s.body['payment_intent_data[setup_future_usage]'] === 'off_session' && s.body['metadata[save_card]'] === '1', 'the card paid with is still kept for a later fee');
  let rows = await clientsWith(A.wid, goneEmail);
  assert(rows.length === 1 && rows[0].stripe_customer_id === s.body.customer && !rows[0].payment_method_id, 'the new client record remembers the new customer, and no card');
  assert(flag(`pm_gone_${STAMP}`) === 'always' && cardWrites().length === 0, 'the deleted client\'s card is not touched');

  // Booking again as the same new client: their own customer, made a moment
  // ago and still empty, is checked with Stripe and reused.
  reset();
  r = await book(A, A.svcDep, goneEmail);
  const s2 = lastSession();
  assert(r.statusCode === 201 && s2.body.customer === s.body.customer && emailLookups().length === 0 && callsTo(/^POST \/customers$/).length === 0, 'a second booking reuses that same customer, no lookup, no extra customer');
  assert(callsTo(/^GET \/customers\/[^/]+\/payment_methods$/).length === 1, 'after asking Stripe what cards it holds');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[2] two client records with one email');
  const dupEmail = `bsc-dup-${STAMP}@example.com`;
  const DUP_CUS = addCustomer(`cus_dup_${STAMP}`, dupEmail);
  addCard(`pm_dup_${STAMP}`, DUP_CUS, 'always');
  const withCard = await mkClient(A.wid, dupEmail, { customer: DUP_CUS, pm: `pm_dup_${STAMP}` });
  const noCard = await mkClient(A.wid, dupEmail, { name: 'Avery (again)' });
  reset();
  let keep = await cardOnFileCheckout({ workspaceId: A.wid, clientId: noCard, service: A.svcDep, mode: 'customer' });
  assert(!!keep?.customerId && keep.customerId !== DUP_CUS && emailLookups().length === 0, 'deposit: the record without a card gets a new customer, never the other record\'s');
  assert((await clientRow(noCard)).stripe_customer_id === keep.customerId, 'and remembers it');
  assert((await clientRow(withCard)).stripe_customer_id === DUP_CUS && (await clientRow(withCard)).payment_method_id === `pm_dup_${STAMP}`, 'the record with the card is untouched');
  reset();
  keep = await cardOnFileCheckout({ workspaceId: A.wid, clientId: withCard, service: A.svcDep, mode: 'customer' });
  assert(keep === null && stripe.calls.length === 0, 'the record WITH a card: no customer is handed out at all (unchanged)');

  const dup2 = `bsc-dup2-${STAMP}@example.com`;
  const DUP2_CUS = addCustomer(`cus_dup2_${STAMP}`, dup2);
  addCard(`pm_dup2_${STAMP}`, DUP2_CUS, 'always');
  await mkClient(A.wid, dup2, { customer: DUP2_CUS, pm: `pm_dup2_${STAMP}` });
  const noCard2 = await mkClient(A.wid, dup2);
  reset();
  const setup = await cardOnFileCheckout({ workspaceId: A.wid, clientId: noCard2, service: A.svcFee, mode: 'setup', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
  s = lastSession();
  assert(/checkout\.stripe\.com/.test(setup?.url || '') && s.body.mode === 'setup' && s.body.customer !== DUP2_CUS && emailLookups().length === 0, 'card page: a new customer, never the other record\'s');
  const dup3 = `bsc-dup3-${STAMP}@example.com`;
  const DUP3_CUS = addCustomer(`cus_dup3_${STAMP}`, dup3);
  const noCard3 = await mkClient(A.wid, dup3);
  reset();
  const reqUrl = await depositCardSetupForRequest({ workspaceId: A.wid, clientId: noCard3, bookingId: null, successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
  s = lastSession();
  assert(/checkout\.stripe\.com/.test(reqUrl || '') && s.body.customer !== DUP3_CUS && emailLookups().length === 0, 'booking request card page: a new customer, never one found by email');

  // Two requests at once agree on one customer.
  const raceEmail = `bsc-race-${STAMP}@example.com`;
  const raceId = await mkClient(A.wid, raceEmail);
  const stale = await clientRow(raceId);
  const creds = { secretKey: process.env.STRIPE_SECRET_KEY, stripeAccount: A.acct };
  const [o1, o2] = await Promise.all([ensureOwnStripeCustomer({ creds, client: stale }), ensureOwnStripeCustomer({ creds, client: stale })]);
  assert(o1.customerId === o2.customerId && o1.created !== o2.created && (await clientRow(raceId)).stripe_customer_id === o1.customerId, 'two bookings at the same moment settle on one customer');
  assert(await ensureOwnStripeCustomer({ creds, client: { id: raceId, workspace_id: A.wid, email: null, stripe_customer_id: null } }) === null, 'no email, no customer');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[3] the client\'s own customer and the deposit page');
  // The record points at a customer, and Ivy knows of no card. Stripe may
  // know better: a card whose removal failed at Stripe, a save whose
  // webhook never arrived.
  const ownEmail = `bsc-own-${STAMP}@example.com`;
  const OWN_CUS = addCustomer(`cus_own_${STAMP}`, ownEmail);
  const ownId = await mkClient(A.wid, ownEmail, { customer: OWN_CUS });
  const OWN_PM = addCard(`pm_own_${STAMP}`, OWN_CUS, 'always');
  reset();
  r = await book(A, A.svcDep, ownEmail);
  s = lastSession();
  assert(r.statusCode === 201 && /checkout\.stripe\.com/.test(r.body.depositCheckoutUrl || ''), 'the booking and its deposit page still go through');
  assert(!s.body.customer && s.body.customer_email === ownEmail, 'a card Stripe would offer: the deposit page gets the email only, no customer');
  assert(!s.body['payment_intent_data[setup_future_usage]'] && !s.body['metadata[save_card]'], 'and keeps no card');
  assert(emailLookups().length === 0 && (await clientRow(ownId)).stripe_customer_id === OWN_CUS, 'no email lookup; the client keeps their customer');
  assert(!r.body.cardSetupUrl, 'no separate card page alongside a deposit page');

  const viaHelper = () => cardOnFileCheckout({ workspaceId: A.wid, clientId: ownId, service: A.svcDep, mode: 'customer' });
  stripe.pms.get(OWN_PM).allow_redisplay = 'unspecified';
  assert(await viaHelper() === null, 'a card with no setting either way: email only');
  stripe.pms.get(OWN_PM).allow_redisplay = 'limited';
  addCard(`pm_own2_${STAMP}`, OWN_CUS, 'always');
  assert(await viaHelper() === null, 'one limited card and one Stripe would offer: email only');
  stripe.pms.delete(`pm_own2_${STAMP}`);
  stripe.failCardList = true;
  assert(await viaHelper() === null, 'Stripe cannot be asked: email only');
  stripe.failCardList = false;
  stripe.cardListHasMore = true;
  assert(await viaHelper() === null, 'more cards than one page lists: email only');
  stripe.cardListHasMore = false;
  assert((await viaHelper())?.customerId === OWN_CUS, 'every card limited: the client\'s own customer is used');
  reset();
  r = await book(A, A.svcDep, ownEmail);
  s = lastSession();
  assert(s.body.customer === OWN_CUS && s.body['payment_intent_data[setup_future_usage]'] === 'off_session' && emailLookups().length === 0, 'and the deposit page keeps the card for a later fee, as before');
  stripe.pms.delete(OWN_PM);
  assert((await viaHelper())?.customerId === OWN_CUS, 'no cards at all: the client\'s own customer is used');
  const cOpts = { secretKey: 'sk_test_x', stripeAccount: A.acct };
  assert(await customerHasNoRedisplayableCard({ ...cOpts, customerId: OWN_CUS }) === true, 'customerHasNoRedisplayableCard: true for an empty customer');
  assert(await customerHasNoRedisplayableCard({ ...cOpts, customerId: GONE_CUS }) === false, 'customerHasNoRedisplayableCard: false when a card would be offered');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[4] card pages opened from the booking form');
  const feeEmail = `bsc-fee-${STAMP}@example.com`;
  const FEE_CUS = addCustomer(`cus_fee_${STAMP}`, feeEmail); // someone else on the account with that email
  addCard(`pm_fee_${STAMP}`, FEE_CUS, 'always');
  reset();
  r = await book(A, A.svcFee, feeEmail);
  s = lastSession();
  assert(r.statusCode === 201 && /checkout\.stripe\.com/.test(r.body.cardSetupUrl || '') && !r.body.depositCheckoutUrl, 'fee service without a deposit: a card page is offered');
  assert(s.body.mode === 'setup' && s.body.customer !== FEE_CUS && /^cus_new_/.test(s.body.customer) && emailLookups().length === 0, 'on a new customer, with no lookup by email');
  assert(s.body['payment_method_data[allow_redisplay]'] === 'limited' && SAVED_CARD_REDISPLAY === 'limited', 'and Stripe is asked to save the card as "limited"');
  assert(s.body['metadata[purpose]'] === 'save_card' && s.body['setup_intent_data[metadata][purpose]'] === 'save_card', 'still marked as a card save for the webhook');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[5] every place that records a saved card limits it');
  // (a) connected account webhook
  const wEmail = `bsc-hook-${STAMP}@example.com`;
  const W_CUS = addCustomer(`cus_hook_${STAMP}`, wEmail);
  const wId = await mkClient(A.wid, wEmail, { customer: W_CUS });
  const W_PM = addCard(`pm_hook_${STAMP}`, null, 'always');
  stripe.setupIntents.set('seti_hook', { id: 'seti_hook', status: 'succeeded', payment_method: W_PM });
  const setupDone = (clientId, wid, si, cus) => ({ id: `cs_setup_${si}`, mode: 'setup', status: 'complete', setup_intent: si, customer: cus, metadata: { purpose: 'save_card', workspace_id: wid, client_id: clientId } });
  reset();
  r = await fire('checkout.session.completed', setupDone(wId, A.wid, 'seti_hook', W_CUS), A.acct);
  assert(r.statusCode === 200 && r.body.marked === 'card-saved' && (await clientRow(wId)).payment_method_id === W_PM, 'webhook: the card is on the client');
  assert(flag(W_PM) === 'limited', 'webhook: Stripe now has the card as "limited"');
  let w = cardWrites()[0];
  assert(cardWrites().length === 1 && w.body.allow_redisplay === 'limited' && w.headers['Stripe-Account'] === A.acct && Object.keys(w.body).length === 1, 'one write, that setting only, on the business\'s account');
  reset();
  r = await fire('checkout.session.completed', setupDone(wId, A.wid, 'seti_hook', W_CUS), A.acct);
  assert(cardWrites().length === 0, 'already limited (a repeat delivery): no second write');

  // Stripe refuses the change: the card is still recorded.
  const W2_PM = addCard(`pm_hook2_${STAMP}`, null, 'always');
  stripe.setupIntents.set('seti_hook2', { id: 'seti_hook2', status: 'succeeded', payment_method: W2_PM });
  const w2Id = await mkClient(A.wid, `bsc-hook2-${STAMP}@example.com`, { customer: addCustomer(`cus_hook2_${STAMP}`, `bsc-hook2-${STAMP}@example.com`) });
  stripe.failPmUpdate = true;
  const quiet = console.error; console.error = () => {};
  r = await fire('checkout.session.completed', setupDone(w2Id, A.wid, 'seti_hook2', `cus_hook2_${STAMP}`), A.acct);
  console.error = quiet;
  stripe.failPmUpdate = false;
  assert(r.body.marked === 'card-saved' && (await clientRow(w2Id)).payment_method_id === W2_PM, 'Stripe refuses the change: the card is recorded all the same');

  // (b) the webhook of a business on its own Stripe key
  const lEmail = `bsc-legacy-${STAMP}@example.com`;
  const L_CUS = addCustomer(`cus_legacy_${STAMP}`, lEmail);
  const lId = await mkClient(L.wid, lEmail, { customer: L_CUS });
  const L_PM = addCard(`pm_legacy_${STAMP}`, null, 'always');
  stripe.setupIntents.set('seti_legacy', { id: 'seti_legacy', status: 'succeeded', payment_method: L_PM });
  reset();
  r = await fireLegacy('checkout.session.completed', setupDone(lId, L.wid, 'seti_legacy', L_CUS), L.wid, 'whsec_bsc_legacy');
  w = cardWrites()[0];
  assert(r.statusCode === 200 && r.body.marked === 'card-saved' && (await clientRow(lId)).payment_method_id === L_PM, 'own-key webhook: the card is on the client');
  assert(flag(L_PM) === 'limited' && cardWrites().length === 1 && w.headers.Authorization === 'Bearer sk_test_bsc_legacy' && !w.headers['Stripe-Account'], 'own-key webhook: limited, with the business\'s own key');

  // (c) back from Stripe in the automatic payments approval
  const apEmail = `bsc-autopay-${STAMP}@example.com`;
  const AP_CUS = addCustomer(`cus_ap_${STAMP}`, apEmail);
  const apId = await mkClient(A.wid, apEmail, { customer: AP_CUS });
  const AP_PM = addCard(`pm_ap_${STAMP}`, null, 'always');
  const series = (await sql`INSERT INTO recurring_invoices (workspace_id, client_id, name, cadence, next_run_at, client_email)
    VALUES (${A.wid}, ${apId}, 'Monthly', 'monthly', '2027-01-01', ${apEmail}) RETURNING id`).rows[0].id;
  const agreement = (await sql`INSERT INTO autopay_agreements (workspace_id, recurring_invoice_id, client_id, status, series_name, cadence, currency)
    VALUES (${A.wid}, ${series}, ${apId}, 'requested', 'Monthly', 'monthly', 'USD') RETURNING id`).rows[0].id;
  stripe.setupIntents.set('seti_ap', { id: 'seti_ap', status: 'succeeded', payment_method: AP_PM });
  stripe.sessions.set('cs_ap_done', setupDone(apId, A.wid, 'seti_ap', AP_CUS));
  reset();
  const synced = await syncSetupSession({ myIds: [apId], agreementId: agreement, sessionId: 'cs_ap_done' });
  assert(synced.last4 === '4242' && (await clientRow(apId)).payment_method_id === AP_PM, 'automatic payments return: the card is on the client');
  assert(flag(AP_PM) === 'limited' && cardWrites().length === 1, 'automatic payments return: limited');

  // (d) a card kept at a deposit or invoice payment
  const payEmail = `bsc-pay-${STAMP}@example.com`;
  const PAY_CUS = addCustomer(`cus_pay_${STAMP}`, payEmail);
  const payId = await mkClient(A.wid, payEmail, { customer: PAY_CUS });
  const PAY_PM = addCard(`pm_pay_${STAMP}`, PAY_CUS, 'limited');
  stripe.pis.set('pi_pay', { id: 'pi_pay', payment_method: PAY_PM, setup_future_usage: 'off_session', customer: PAY_CUS });
  reset();
  let stored = await storeCardFromPaymentIntent({ creds, workspaceId: A.wid, clientId: payId, paymentIntentId: 'pi_pay' });
  assert(stored?.last4 === '4242' && cardWrites().length === 0, 'kept at payment, already limited (how Stripe saves these): recorded, nothing to change');
  stripe.pms.get(PAY_PM).allow_redisplay = 'always';
  reset();
  stored = await storeCardFromPaymentIntent({ creds, workspaceId: A.wid, clientId: payId, paymentIntentId: 'pi_pay' });
  assert(stored?.last4 === '4242' && flag(PAY_PM) === 'limited' && cardWrites().length === 1, 'kept at payment but marked "always": limited');

  assert(await limitSavedCardRedisplay({ secretKey: 'sk_test_x', paymentMethodId: null }) === 'failed', 'limitSavedCardRedisplay: no card id, no call');
  assert(await limitSavedCardRedisplay({ secretKey: 'sk_test_x', paymentMethod: { id: PAY_PM, allow_redisplay: 'limited' } }) === 'already', 'limitSavedCardRedisplay: "already" without a call');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[6] a Stripe account that refuses the new setting');
  stripe.refuseRedisplayParam = true;
  reset();
  const made = await createSetupCheckoutSession({ secretKey: 'sk_test_x', stripeAccount: A.acct, customerId: W_CUS, workspaceId: A.wid, clientId: wId, successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
  const tries = callsTo(/^POST \/checkout\/sessions$/);
  assert(/checkout\.stripe\.com/.test(made.url) && tries.length === 2, 'the card page is still made, on a second try');
  assert(tries[0].body['payment_method_data[allow_redisplay]'] === 'limited' && !('payment_method_data[allow_redisplay]' in tries[1].body) && tries[1].body.customer === W_CUS && tries[1].body['metadata[purpose]'] === 'save_card', 'the second try drops that setting and nothing else');
  stripe.refuseRedisplayParam = false;
  let threw = null;
  try { await createSetupCheckoutSession({ secretKey: 'sk_test_x', stripeAccount: A.acct, customerId: '', workspaceId: A.wid, clientId: wId }); } catch (e) { threw = e; }
  assert(/customerId is required/.test(threw?.message || ''), 'any other problem is still an error');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[7] charging a saved card is unchanged');
  // That Stripe charges a "limited" card off-session was checked against
  // Stripe itself in test mode; here: Ivy's request is what it always was.
  reset();
  const pi = await chargeOffSession({ secretKey: 'sk_test_x', stripeAccount: A.acct, customerId: W_CUS, paymentMethodId: W_PM, amountCents: 4000, currency: 'USD', description: 'Late fee', idempotencyKey: `bsc-${STAMP}` });
  const charge = callsTo(/^POST \/payment_intents$/)[0];
  assert(pi.status === 'succeeded' && charge.body.customer === W_CUS && charge.body.payment_method === W_PM && charge.body.off_session === 'true' && charge.body.confirm === 'true' && charge.body.amount === '4000', 'off-session charge names the customer and the saved card, as before');
  assert(!Object.keys(charge.body).some((k) => /redisplay/.test(k)) && stripe.calls.length === 1, 'and says nothing about redisplay');

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[8] one person, one client record');
  const mixed = `Bsc.Jane-${STAMP}@Example.com`;
  const janeId = await mkClient(A.wid, mixed, { name: 'Jane Capital' });
  reset();
  r = await call(packageCheckout, post({ slug: A.slug, packageId: A.pkg.id, name: 'Jane', email: mixed.toLowerCase() }));
  rows = await clientsWith(A.wid, mixed);
  assert(r.statusCode === 200 && rows.length === 1, `package checkout: typed in lower case, still one client record (${rows.length})`);
  assert(lastSession()?.body['metadata[client_id]'] === janeId && lastSession().body.customer_email === mixed.toLowerCase() && !lastSession().body.customer, 'the purchase goes to that client; the page gets the email only');
  r = await book(A, A.svcFee, mixed.toLowerCase(), 'Jane');
  rows = await clientsWith(A.wid, mixed);
  const bk = (await sql`SELECT client_id FROM bookings WHERE id = ${r.body.booking.id}`).rows[0];
  assert(r.statusCode === 201 && rows.length === 1 && bk.client_id === janeId, `booking form: same, the booking lands on the existing client (${rows.length})`);

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[9] the booking form cannot quietly go back');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Comments explain the old behaviour; only the code is checked.
  const code = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const rel of ['api/calendar/public/[slug].js', 'api/_lib/bookingFees.js', 'api/_lib/bookingRequests.js']) {
    const src = code(rel);
    assert(!/findOrCreateCustomer|\bensureStripeCustomer\b/.test(src), `${rel}: no Stripe customer lookup by email`);
  }
  assert(/ensureOwnStripeCustomer/.test(code('api/_lib/bookingFees.js')) && /customerHasNoRedisplayableCard/.test(code('api/_lib/bookingFees.js')), 'the deposit path uses the client\'s own customer, checked with Stripe');
  const own = code('api/_lib/savedCards.js').match(/export async function ensureOwnStripeCustomer[\s\S]*?\n}\n/)?.[0] || '';
  assert(own.length > 0 && !/findOrCreateCustomer|customers\?email/.test(own) && /createCustomer\(/.test(own), 'ensureOwnStripeCustomer makes a customer and never looks one up');
  assert(/'payment_method_data\[allow_redisplay\]': SAVED_CARD_REDISPLAY/.test(code('api/_lib/stripe.js')), 'the one card setup page helper asks for "limited"');
  for (const rel of ['api/webhooks/stripe-platform.js', 'api/webhooks/stripe/[workspaceId].js', 'api/_lib/autopay.js', 'api/_lib/savedCards.js']) {
    assert(/limitSavedCardRedisplay\(/.test(code(rel)), `${rel}: limits the card it records`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n[10] the backfill script');
  // Its own two businesses, so the count is exact.
  const B1 = await mkBiz('fillone');
  const B2 = await mkBiz('filltwo', { legacySecret: 'whsec_bsc_fill' });
  cleanupUsers.push(B1.uid, B2.uid);
  // Connected account: a card a client record holds, a card whose client
  // was deleted (only Stripe knows it), one already limited, one detached.
  const b1Cus = addCustomer(`cus_b1_${STAMP}`, 'b1@example.com');
  const b1Known = addCard(`pm_b1_known_${STAMP}`, b1Cus, 'always');
  await mkClient(B1.wid, `bsc-b1-${STAMP}@example.com`, { customer: b1Cus, pm: b1Known });
  const b1Orphan = addCard(`pm_b1_orphan_${STAMP}`, `cus_b1_deleted_${STAMP}`, 'always');
  const b1Limited = addCard(`pm_b1_limited_${STAMP}`, b1Cus, 'limited');
  const b1Detached = addCard(`pm_b1_detached_${STAMP}`, null, 'always');
  const si = (id, pm, account, extra = {}) => stripe.setupIntents.set(id, { id, status: 'succeeded', payment_method: pm, customer: stripe.pms.get(pm)?.customer || null, metadata: {}, account, ...extra });
  si('seti_b1_a', b1Known, B1.acct); si('seti_b1_b', b1Orphan, B1.acct); si('seti_b1_c', b1Limited, B1.acct); si('seti_b1_d', b1Detached, B1.acct);
  stripe.setupIntents.set('seti_b1_e', { id: 'seti_b1_e', status: 'requires_payment_method', payment_method: null, metadata: {}, account: B1.acct });
  // Own-key account: Ivy's own save (marked), and a card another tool saved.
  const b2Ours = addCard(`pm_b2_ours_${STAMP}`, `cus_b2_ours_${STAMP}`, 'always');
  const b2Foreign = addCard(`pm_b2_foreign_${STAMP}`, `cus_b2_foreign_${STAMP}`, 'always');
  si('seti_b2_a', b2Ours, null, { metadata: { purpose: 'save_card', workspace_id: B2.wid } });
  si('seti_b2_b', b2Foreign, null);

  const lines = [];
  reset();
  let t1 = await runBackfill({ workspaceId: B1.wid, log: (l) => lines.push(l) });
  assert(t1.found === 2 && t1.limited === 0 && cardWrites().length === 0 && callsTo(/^POST /).length === 0, `dry run: finds 2 cards, writes nothing (${t1.found})`);
  assert(flag(b1Known) === 'always' && flag(b1Orphan) === 'always', 'dry run: both cards are as they were');
  assert(/^DRY RUN/.test(lines[0]) && lines.some((l) => l.includes(`would limit ${b1Orphan}`)) && /Nothing was changed/.test(lines.at(-1)), 'dry run: says so, and names each card');
  reset();
  t1 = await runBackfill({ apply: true, workspaceId: B1.wid, log: () => {} });
  assert(t1.found === 2 && t1.limited === 2 && t1.failed === 0 && flag(b1Known) === 'limited' && flag(b1Orphan) === 'limited', 'apply: the known card and the deleted client\'s card are limited');
  assert(cardWrites().length === 2 && cardWrites().every((c) => c.headers['Stripe-Account'] === B1.acct && c.body.allow_redisplay === 'limited' && Object.keys(c.body).length === 1), 'apply: one write per card, that setting only, on that business\'s account');
  assert(flag(b1Detached) === 'always' && callsTo(/^(DELETE|POST) \/(customers|payment_intents|checkout)/).length === 0, 'apply: a detached card is left alone; nothing else is written');
  reset();
  t1 = await runBackfill({ apply: true, workspaceId: B1.wid, log: () => {} });
  assert(t1.found === 0 && cardWrites().length === 0, 'run again: nothing left to do');
  reset();
  const t2 = await runBackfill({ apply: true, workspaceId: B2.wid, log: () => {} });
  assert(t2.limited === 1 && flag(b2Ours) === 'limited' && flag(b2Foreign) === 'always', 'own-key account: Ivy\'s save is limited, another tool\'s card is not touched');
  stripe.failPmUpdate = true;
  stripe.pms.get(b2Ours).allow_redisplay = 'always';
  const t3 = await runBackfill({ apply: true, workspaceId: B2.wid, log: () => {} });
  stripe.failPmUpdate = false;
  assert(t3.found === 1 && t3.limited === 0 && t3.failed === 1, 'a refused write is counted as failed, not hidden');

  // ── cleanup ─────────────────────────────────────────────────────────
  await settle();
  for (const uid of cleanupUsers) await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
