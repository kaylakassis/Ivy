// Every payment that lands on an invoice is kept as its own row
// (invoice_payments), so a refund goes back to the payment that took the
// money and a refund made in a payment dashboard against ANY of an
// invoice's payments updates that payment and the invoice.
//
//   [1] Stripe: two part payments are two ledger rows; the paired event for
//       the same payment adds nothing
//   [2] an app refund is split across payments newest first, one processor
//       refund per payment, never more than each payment has left
//   [3] a Stripe Dashboard refund of the OLDER payment updates that payment
//       and the invoice (it used to be ignored: only the latest payment id
//       was known); the echo adds nothing; refunding everything flips the
//       invoice to refunded
//   [4] never more than was paid; no processor call
//   [5] a later processor refund fails: what went through is recorded and
//       reported exactly, what did not is reported as not refunded (route
//       and core); the invoice never claims more
//   [6] Square: payments are rows; a dashboard refund of the older payment
//       counts once; the app refund uses the INVOICE currency; the webhook
//       for the app's own refunds adds nothing
//   [7] PayPal: same, invoice currency, dashboard refund of the older capture
//   [8] owner Mark paid after a card part payment: a manual row for the rest;
//       refunds come off the manual money first (no processor call)
//   [9] backfill: one marked row per existing paid / part-paid invoice from
//       the data on the invoice; running it again adds nothing; an invoice
//       with no rows (paid before the ledger) still refunds
//   [10] two refunds at the same moment: one goes through, the other is
//       told to wait; never more than was paid
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/invoice-payment-ledger.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_ledger';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_ledger';
process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'sqsig_ledger';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.PAYPAL_CLIENT_ID ||= 'pp_client_ledger';
process.env.PAYPAL_CLIENT_SECRET ||= 'pp_secret_ledger';
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied, splitStatements } from '../api/_lib/ensureSchema.js';
import { SCHEMA_SQL } from '../api/_lib/schema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { encrypt } from '../api/_lib/secrets.js';
import { refundInvoice } from '../api/_lib/refunds.js';
import refundHandler from '../api/invoices/refund.js';
import markPaidHandler from '../api/invoices/mark-paid.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import squareWebhook from '../api/webhooks/square/[workspaceId].js';
import { applyPaymentToInvoice as paypalApply, applyRefundToInvoice as paypalRefund } from '../api/_lib/paypalApply.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const STAMP = Date.now();
const calls = { stripe: [], square: [], paypal: [] };
const failStripeFor = new Set();
let refundN = 0;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com\/v1\/refunds/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    await new Promise((r) => setTimeout(r, 25));
    if (failStripeFor.has(body.payment_intent)) {
      return json({ error: { message: 'This charge is disputed and cannot be refunded' } }, 400);
    }
    calls.stripe.push({ body, key: init.headers?.['Idempotency-Key'] });
    return json({ id: `re_${STAMP}_${++refundN}`, amount: Number(body.amount), status: 'succeeded' });
  }
  if (/squareup(sandbox)?\.com\/v2\/refunds/.test(u)) {
    const body = JSON.parse(String(init.body || '{}'));
    calls.square.push(body);
    return json({ refund: { id: `SQR-${STAMP}-${++refundN}`, amount_money: body.amount_money, status: 'PENDING' } });
  }
  if (/paypal\.com\/v1\/oauth2\/token/.test(u)) return json({ access_token: 'pp_tok', expires_in: 32400 });
  const pp = u.match(/paypal\.com\/v2\/payments\/captures\/([^/]+)\/refund/);
  if (pp) {
    const body = JSON.parse(String(init.body || '{}'));
    calls.paypal.push({ capture: decodeURIComponent(pp[1]), body });
    return json({ id: `PPR-${STAMP}-${++refundN}`, amount: body.amount, status: 'COMPLETED' });
  }
  return json({ id: 'x' });
};

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
const HOST = 'www.joinivy.ai';
const req = ({ method = 'POST', cookie, query = {}, body = {} } = {}) => ({
  method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin: `https://${HOST}`, host: HOST, 'x-forwarded-for': '198.18.91.7', ...(cookie ? { cookie } : {}) },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }

let evtN = 0;
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_led_${STAMP}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload,
    headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}
async function fireSquare(wid, type, object) {
  const payload = JSON.stringify({ event_id: `sq_led_${STAMP}_${++evtN}`, type, data: { object } });
  const url = `${process.env.APP_URL.replace(/\/$/, '')}/api/webhooks/square/${wid}`;
  const sig = crypto.createHmac('sha256', process.env.SQUARE_WEBHOOK_SIGNATURE_KEY).update(url + payload).digest('base64');
  const res = mkRes();
  await squareWebhook({ method: 'POST', url: `/api/webhooks/square/${wid}`, query: { workspaceId: wid }, body: payload,
    headers: { 'x-square-hmacsha256-signature': sig, 'content-type': 'application/json' } }, res);
  return res;
}

const made = [];
async function mkBiz(label, finance) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`led-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await finance(wid);
  const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Casey Client', ${`led-client-${label}-${STAMP}@example.com`}, 'active') RETURNING id`).rows[0].id;
  made.push({ u, wid });
  return { wid, cid, cookie: `ivy_session=${signSession(u)}` };
}
async function mkInvoice(biz, number, amount, { currency = 'USD', order = null } = {}) {
  return (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, client_email, number, status, items, tax_rate, discount, sent_at, due_date, currency, stripe_session_id)
    VALUES (${biz.wid}, ${biz.cid}, 'Casey Client', ${`led-pay-${STAMP}@example.com`}, ${number}, 'sent',
            ${JSON.stringify([{ id: 'li1', description: 'Session', quantity: 1, rate: amount }])}::jsonb, 0, 0, NOW(), CURRENT_DATE + 14, ${currency}, ${order})
    RETURNING id`).rows[0].id;
}
const invRow = (id) => sql`SELECT * FROM invoices WHERE id = ${id}`.then((r) => r.rows[0]);
const ledger = (id) => sql`SELECT * FROM invoice_payments WHERE invoice_id = ${id} ORDER BY created_at ASC, id ASC`.then((r) => r.rows);
const num = (v) => Number(v || 0);
const stripePaid = (biz, acct, invoiceId, pi, cents) => fire('checkout.session.completed', {
  id: `cs_${pi}`, mode: 'payment', payment_status: 'paid', status: 'complete',
  payment_intent: pi, amount_total: cents, payment_method_types: ['card'],
  metadata: { invoice_id: invoiceId, workspace_id: biz.wid },
}, acct);
const pause = () => new Promise((r) => setTimeout(r, 15));

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] Stripe: each part payment is its own row');
  const acct = `acct_led_${STAMP}`;
  const S = await mkBiz('stripe', (wid) => sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status)
    VALUES (${wid}, ${acct}, 'complete')`);
  const inv1 = await mkInvoice(S, `LED-S1-${STAMP}`, 100);
  const pi1 = `pi_led1_${STAMP}`;
  const pi2 = `pi_led2_${STAMP}`;
  await stripePaid(S, acct, inv1, pi1, 8000);
  await pause();
  await fire('payment_intent.succeeded', { id: pi1, amount: 8000, amount_received: 8000, payment_method_types: ['card'], metadata: { invoice_id: inv1, workspace_id: S.wid } }, acct);
  await stripePaid(S, acct, inv1, pi2, 2000);
  let rows = await ledger(inv1);
  let row = await invRow(inv1);
  assert(row.status === 'paid' && num(row.paid_amount) === 100, `invoice paid in full ($${row.paid_amount})`);
  assert(rows.length === 2, `two ledger rows (${rows.length})`);
  assert(rows[0]?.provider === 'stripe' && rows[0]?.provider_payment_id === pi1 && num(rows[0]?.amount) === 80 && rows[0]?.backfilled === false && rows[0]?.currency === 'USD',
    'older row: Stripe, first payment id, $80, not backfilled');
  assert(rows[1]?.provider_payment_id === pi2 && num(rows[1]?.amount) === 20, 'newer row: second payment id, $20');
  assert(rows.every((x) => x.workspace_id === S.wid), 'rows carry the workspace');

  console.log('\n[2] app refund: newest payment first, one processor refund per payment');
  calls.stripe.length = 0;
  let out = await refundInvoice({ workspaceId: S.wid, id: inv1, amount: 50 });
  assert(calls.stripe.length === 2, `two processor refunds (${calls.stripe.length})`);
  assert(calls.stripe[0]?.body.payment_intent === pi2 && calls.stripe[0]?.body.amount === '2000', 'first: the newer $20 payment, all of it');
  assert(calls.stripe[1]?.body.payment_intent === pi1 && calls.stripe[1]?.body.amount === '3000', 'then: $30 from the older payment');
  assert(calls.stripe[0]?.key !== calls.stripe[1]?.key, 'each refund has its own idempotency key');
  rows = await ledger(inv1);
  assert(num(rows[1].refunded_amount) === 20 && num(rows[0].refunded_amount) === 30, 'each payment row records its share');
  row = await invRow(inv1);
  assert(num(row.refunded_amount) === 50 && row.status === 'paid', `invoice: $50 refunded, still paid (${row.refunded_amount} ${row.status})`);
  assert(out.refund.amount === 50 && out.refund.fullyRefunded === false && Array.isArray(out.refund.parts) && out.refund.parts.length === 2,
    `response keeps its shape and lists the parts (${JSON.stringify(out.refund)})`);
  assert(out.invoice.refundedAmount === 50, 'serialized invoice shows $50 refunded');

  console.log('\n[3] Stripe Dashboard refund of the OLDER payment');
  let w = await fire('charge.refunded', { id: `ch_${pi1}`, payment_intent: pi1, amount: 8000, amount_refunded: 5000 }, acct);
  rows = await ledger(inv1);
  row = await invRow(inv1);
  assert(w.body?.applied === 'invoice-refund-synced', `synced (${JSON.stringify(w.body)})`);
  assert(num(rows[0].refunded_amount) === 50 && num(row.refunded_amount) === 70 && row.status === 'paid',
    `older payment now $50 refunded, invoice $70 (${rows[0].refunded_amount} / ${row.refunded_amount})`);
  w = await fire('charge.refunded', { id: `ch_${pi1}`, payment_intent: pi1, amount: 8000, amount_refunded: 5000 }, acct);
  row = await invRow(inv1);
  assert(num(row.refunded_amount) === 70, 'the same cumulative amount again adds nothing');
  w = await fire('charge.refunded', { id: `ch_${pi2}`, payment_intent: pi2, amount: 2000, amount_refunded: 2000 }, acct);
  row = await invRow(inv1);
  assert(num(row.refunded_amount) === 70, "the echo of the app's refund of the newer payment adds nothing");
  w = await fire('charge.refunded', { id: `ch_${pi1}`, payment_intent: pi1, amount: 8000, amount_refunded: 8000 }, acct);
  rows = await ledger(inv1);
  row = await invRow(inv1);
  assert(num(rows[0].refunded_amount) === 80 && num(row.refunded_amount) === 100 && row.status === 'refunded',
    `everything back: invoice refunded (${row.refunded_amount} ${row.status})`);

  console.log('\n[4] never more than was paid');
  const inv4 = await mkInvoice(S, `LED-S4-${STAMP}`, 100);
  await stripePaid(S, acct, inv4, `pi_led4_${STAMP}`, 10000);
  calls.stripe.length = 0;
  let threw = null;
  try { await refundInvoice({ workspaceId: S.wid, id: inv4, amount: 150 }); } catch (e) { threw = e; }
  assert(!!threw && /more than/.test(threw.message) && calls.stripe.length === 0, `refused, no processor call (${threw?.message})`);
  row = await invRow(inv4);
  assert(num(row.refunded_amount) === 0, 'nothing recorded');

  console.log('\n[5] a later processor refund fails: report exactly what went through');
  const inv5 = await mkInvoice(S, `LED-S5-${STAMP}`, 100);
  const piA = `pi_led5a_${STAMP}`;
  const piB = `pi_led5b_${STAMP}`;
  await stripePaid(S, acct, inv5, piA, 6000);
  await pause();
  await stripePaid(S, acct, inv5, piB, 4000);
  failStripeFor.add(piA);
  calls.stripe.length = 0;
  threw = null;
  try { await refundInvoice({ workspaceId: S.wid, id: inv5, amount: 70 }); } catch (e) { threw = e; }
  assert(!!threw, 'the refund reports a problem');
  assert(/\$40\.00/.test(threw?.message || '') && /\$30\.00/.test(threw?.message || '') && /not refunded/i.test(threw?.message || ''),
    `message says $40 went back and $30 did not (${threw?.message})`);
  assert(threw?.partial?.refunded === 40 && threw?.partial?.notRefunded === 30, `error carries the split (${JSON.stringify(threw?.partial && { r: threw.partial.refunded, n: threw.partial.notRefunded })})`);
  rows = await ledger(inv5);
  row = await invRow(inv5);
  assert(num(row.refunded_amount) === 40 && row.status === 'paid', `invoice records only the $40 (${row.refunded_amount})`);
  assert(num(rows[1].refunded_amount) === 40 && num(rows[0].refunded_amount) === 0, 'only the newer payment row moved');
  assert((row.activity || []).filter((a) => a.kind === 'refund').length === 1 && /\$40\.00/.test((row.activity || []).find((a) => a.kind === 'refund')?.text || ''),
    'one activity line for the $40 that went back');
  // Same through the owner route: a 400 that still says what happened.
  const r5 = await call(refundHandler, req({ cookie: S.cookie, body: { id: inv5, amount: 30 } }));
  assert(r5.statusCode === 400 && /disputed/.test(r5.body?.error || ''), `route: the failed refund is a 400 with the reason (${r5.body?.error})`);
  row = await invRow(inv5);
  assert(num(row.refunded_amount) === 40, 'nothing more recorded');
  const inv5b = await mkInvoice(S, `LED-S5B-${STAMP}`, 100);
  failStripeFor.add(`pi_led5c_${STAMP}`);
  await stripePaid(S, acct, inv5b, `pi_led5c_${STAMP}`, 6000);
  await pause();
  await stripePaid(S, acct, inv5b, `pi_led5d_${STAMP}`, 4000);
  const r5p = await call(refundHandler, req({ cookie: S.cookie, body: { id: inv5b, amount: 70 } }));
  assert(r5p.statusCode === 400 && /Only \$40\.00 of the \$70\.00/.test(r5p.body?.error || '')
    && r5p.body?.details?.refunded === 40 && r5p.body?.details?.notRefunded === 30 && r5p.body?.details?.invoice?.refundedAmount === 40,
    `route: a part-way refund says what went back and returns the invoice as it stands (${JSON.stringify({ e: r5p.body?.error, d: r5p.body?.details && { r: r5p.body.details.refunded, n: r5p.body.details.notRefunded } })})`);
  failStripeFor.clear();
  const r5b = await call(refundHandler, req({ cookie: S.cookie, body: { id: inv5, amount: 30 } }));
  assert(r5b.statusCode === 200 && r5b.body?.refund?.amount === 30 && r5b.body?.invoice?.refundedAmount === 70, `retry once it clears: $30 more (${JSON.stringify(r5b.body?.refund)})`);
  const r5c = await call(refundHandler, req({ cookie: S.cookie, body: { id: inv5, amount: 31 } }));
  assert(r5c.statusCode === 400 && /more than/.test(r5c.body?.error || ''), 'route: more than what is left is refused');

  console.log('\n[6] Square: rows, dashboard refund of the older payment, invoice currency');
  const Q = await mkBiz('square', (wid) => sql`INSERT INTO finance_settings (workspace_id, payment_provider, square_merchant_id, square_credentials_encrypted, currency)
    VALUES (${wid}, 'square', ${`SQM-LED-${STAMP}`}, ${encrypt(JSON.stringify({ access_token: 'sq_tok' }))}, 'USD')`);
  const order6 = `ORD-LED6-${STAMP}`;
  const inv6 = await mkInvoice(Q, `LED-Q6-${STAMP}`, 100, { currency: 'CAD', order: order6 });
  const sq1 = { id: `SQP1-${STAMP}`, order_id: order6, status: 'COMPLETED', amount_money: { amount: 7000, currency: 'CAD' } };
  const sq2 = { id: `SQP2-${STAMP}`, order_id: order6, status: 'COMPLETED', amount_money: { amount: 3000, currency: 'CAD' } };
  await fireSquare(Q.wid, 'payment.created', { payment: sq1 });
  await fireSquare(Q.wid, 'payment.updated', { payment: sq1 });
  await pause();
  await fireSquare(Q.wid, 'payment.created', { payment: sq2 });
  rows = await ledger(inv6);
  row = await invRow(inv6);
  assert(row.status === 'paid' && rows.length === 2 && rows.every((x) => x.provider === 'square' && x.currency === 'CAD'),
    `paid; two Square rows in the invoice currency (${rows.length} ${row.status})`);
  const dash = { id: `SQDASH-${STAMP}`, payment_id: sq1.id, status: 'COMPLETED', amount_money: { amount: 2000, currency: 'CAD' } };
  await fireSquare(Q.wid, 'refund.updated', { refund: dash });
  await fireSquare(Q.wid, 'refund.updated', { refund: dash });
  rows = await ledger(inv6);
  row = await invRow(inv6);
  assert(num(rows[0].refunded_amount) === 20 && num(row.refunded_amount) === 20 && row.status === 'paid',
    `dashboard refund of the older payment counted once (${rows[0].refunded_amount} / ${row.refunded_amount})`);
  calls.square.length = 0;
  out = await refundInvoice({ workspaceId: Q.wid, id: inv6 });
  assert(out.refund.amount === 80 && out.refund.fullyRefunded === true, `the $80 left is refunded (${out.refund.amount})`);
  assert(calls.square.length === 2 && calls.square[0].payment_id === sq2.id && calls.square[0].amount_money?.amount === 3000
    && calls.square[1].payment_id === sq1.id && calls.square[1].amount_money?.amount === 5000,
    `newest first: $30 then $50 (${JSON.stringify(calls.square.map((c) => [c.payment_id, c.amount_money?.amount]))})`);
  assert(calls.square.every((c) => c.amount_money?.currency === 'CAD'), 'refunds use the invoice currency (CAD), not the workspace default');
  row = await invRow(inv6);
  assert(row.status === 'refunded' && num(row.refunded_amount) === 100, 'invoice refunded in full');
  for (const p of out.refund.parts) {
    // eslint-disable-next-line no-await-in-loop
    await fireSquare(Q.wid, 'refund.updated', { refund: { id: p.providerRefundId, payment_id: p.providerPaymentId, status: 'COMPLETED', amount_money: { amount: Math.round(p.amount * 100), currency: 'CAD' } } });
  }
  row = await invRow(inv6);
  assert(num(row.refunded_amount) === 100, "the webhook for the app's own refunds adds nothing");

  console.log('\n[7] PayPal: rows, dashboard refund of the older capture, invoice currency');
  const P = await mkBiz('paypal', (wid) => sql`INSERT INTO finance_settings (workspace_id, payment_provider, paypal_merchant_id, currency)
    VALUES (${wid}, 'paypal', ${`M-LED-${STAMP}`}, 'USD')`);
  const inv7 = await mkInvoice(P, `LED-P7-${STAMP}`, 100, { currency: 'EUR' });
  await paypalApply({ workspaceId: P.wid, parsed: { metadata: { invoice_id: inv7 }, paymentId: `CAP1-${STAMP}`, amountCents: 6000 } });
  await pause();
  await paypalApply({ workspaceId: P.wid, parsed: { metadata: { invoice_id: inv7 }, paymentId: `CAP2-${STAMP}`, amountCents: 4000 } });
  rows = await ledger(inv7);
  assert(rows.length === 2 && rows.every((x) => x.provider === 'paypal' && x.currency === 'EUR'), `two PayPal rows (${rows.length})`);
  const ppDash = { paymentId: `CAP1-${STAMP}`, refundId: `PPDASH-${STAMP}`, amountCents: 1000 };
  await paypalRefund({ workspaceId: P.wid, parsed: ppDash });
  const again = await paypalRefund({ workspaceId: P.wid, parsed: ppDash });
  rows = await ledger(inv7);
  row = await invRow(inv7);
  assert(again === 'already-applied' && num(rows[0].refunded_amount) === 10 && num(row.refunded_amount) === 10,
    `dashboard refund of the older capture counted once (${again}, ${row.refunded_amount})`);
  calls.paypal.length = 0;
  out = await refundInvoice({ workspaceId: P.wid, id: inv7, amount: 20 });
  assert(calls.paypal.length === 1 && calls.paypal[0].capture === `CAP2-${STAMP}` && calls.paypal[0].body.amount?.value === '20.00'
    && calls.paypal[0].body.amount?.currency_code === 'EUR', `refund of the newer capture in EUR (${JSON.stringify(calls.paypal[0])})`);
  row = await invRow(inv7);
  assert(num(row.refunded_amount) === 30, 'invoice: $30 refunded in all');

  console.log('\n[8] owner Mark paid after a card part payment');
  const inv8 = await mkInvoice(S, `LED-S8-${STAMP}`, 100);
  const pi8 = `pi_led8_${STAMP}`;
  await stripePaid(S, acct, inv8, pi8, 3000);
  await pause();
  let r = await call(markPaidHandler, req({ cookie: S.cookie, body: { id: inv8, method: 'cash' } }));
  rows = await ledger(inv8);
  assert(r.statusCode === 200 && rows.length === 2 && rows[1].provider === 'manual' && num(rows[1].amount) === 70,
    `a $70 manual row next to the $30 card row (${JSON.stringify(rows.map((x) => [x.provider, x.amount]))})`);
  calls.stripe.length = 0;
  out = await refundInvoice({ workspaceId: S.wid, id: inv8, amount: 50 });
  assert(calls.stripe.length === 0 && out.refund.amount === 50, 'refund comes off the cash first: no processor call');
  out = await refundInvoice({ workspaceId: S.wid, id: inv8 });
  assert(calls.stripe.length === 1 && calls.stripe[0].body.payment_intent === pi8 && calls.stripe[0].body.amount === '3000' && out.refund.amount === 50,
    `the rest: $20 cash + $30 back to the card (${JSON.stringify(calls.stripe.map((c) => c.body))})`);
  row = await invRow(inv8);
  assert(row.status === 'refunded' && num(row.refunded_amount) === 100, 'invoice refunded in full');

  console.log('\n[9] backfill for invoices paid before the ledger');
  const legacyPaid = (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, number, status, items, tax_rate, discount, paid_amount, paid_at, paid_method, stripe_payment_intent, refunded_amount)
    VALUES (${S.wid}, ${S.cid}, 'Casey Client', ${`LED-L1-${STAMP}`}, 'paid', ${JSON.stringify([{ quantity: 1, rate: 100 }])}::jsonb, 0, 0, 100, NOW() - INTERVAL '3 days', 'card', ${`pi_legacy_${STAMP}`}, 25)
    RETURNING id`).rows[0].id;
  const legacyPart = (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, number, status, items, tax_rate, discount, paid_amount, paid_method)
    VALUES (${S.wid}, ${S.cid}, 'Casey Client', ${`LED-L2-${STAMP}`}, 'sent', ${JSON.stringify([{ quantity: 1, rate: 100 }])}::jsonb, 0, 0, 40, 'venmo')
    RETURNING id`).rows[0].id;
  const backfill = splitStatements(SCHEMA_SQL).find((s) => /INSERT INTO invoice_payments/.test(s) && /backfilled/.test(s));
  assert(!!backfill, 'the schema carries a backfill statement');
  if (backfill) {
    // The real statement, kept to this test's business: other suites share
    // the database and delete their own invoices while this runs.
    assert(backfill.includes('WHERE i.paid_amount > 0'), 'backfill filter found');
    const scoped = backfill.replace('WHERE i.paid_amount > 0', 'WHERE i.workspace_id = $1 AND i.paid_amount > 0');
    await sql.query(scoped, [S.wid]);
    await sql.query(scoped, [S.wid]);
  }
  const lp = await ledger(legacyPaid);
  const lq = await ledger(legacyPart);
  assert(lp.length === 1 && lp[0].backfilled === true && lp[0].provider === 'stripe' && lp[0].provider_payment_id === `pi_legacy_${STAMP}`
    && num(lp[0].amount) === 100 && num(lp[0].refunded_amount) === 25, `paid invoice: one marked row, $100, $25 refunded (${JSON.stringify(lp.map((x) => [x.provider, x.amount, x.refunded_amount, x.backfilled]))})`);
  assert(lq.length === 1 && lq[0].backfilled === true && lq[0].provider === 'manual' && num(lq[0].amount) === 40, 'part-paid invoice: one marked $40 manual row');
  assert(num((await ledger(inv1)).length) === 2, 'invoices already on the ledger get no extra row');
  // Paid before the ledger and never backfilled (rows inserted later): a
  // refund still works and writes the marked row itself.
  const legacy3 = (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, number, status, items, tax_rate, discount, paid_amount, paid_at, paid_method, stripe_payment_intent)
    VALUES (${S.wid}, ${S.cid}, 'Casey Client', ${`LED-L3-${STAMP}`}, 'paid', ${JSON.stringify([{ quantity: 1, rate: 60 }])}::jsonb, 0, 0, 60, NOW(), 'card', ${`pi_legacy3_${STAMP}`})
    RETURNING id`).rows[0].id;
  calls.stripe.length = 0;
  out = await refundInvoice({ workspaceId: S.wid, id: legacy3, amount: 15 });
  const l3 = await ledger(legacy3);
  assert(out.refund.amount === 15 && calls.stripe.length === 1 && calls.stripe[0].body.payment_intent === `pi_legacy3_${STAMP}`, 'legacy invoice refunds through its payment');
  assert(l3.length === 1 && l3[0].backfilled === true && num(l3[0].refunded_amount) === 15, 'and now has a marked ledger row');

  console.log('\n[10] two refunds at the same moment');
  const inv10 = await mkInvoice(S, `LED-S10-${STAMP}`, 100);
  await stripePaid(S, acct, inv10, `pi_led10_${STAMP}`, 10000);
  calls.stripe.length = 0;
  const results = await Promise.allSettled([
    refundInvoice({ workspaceId: S.wid, id: inv10, amount: 60 }),
    refundInvoice({ workspaceId: S.wid, id: inv10, amount: 60 }),
  ]);
  const okN = results.filter((x) => x.status === 'fulfilled').length;
  const errs = results.filter((x) => x.status === 'rejected').map((x) => x.reason?.message);
  row = await invRow(inv10);
  assert(okN === 1 && errs.length === 1 && /already|in progress|moment/i.test(errs[0] || ''), `one goes through, the other is told to wait (${errs[0]})`);
  assert(num(row.refunded_amount) === 60 && calls.stripe.length === 1, `$60 refunded once (${row.refunded_amount}, ${calls.stripe.length} calls)`);
}

run()
  .catch((err) => { console.error('Fatal:', err.message, err.stack); fail++; })
  .finally(async () => {
    for (const m of made) {
      await sql`DELETE FROM invoice_payments WHERE workspace_id = ${m.wid}`.catch(() => {});
      await sql`DELETE FROM invoices WHERE workspace_id = ${m.wid}`.catch(() => {});
      await sql`DELETE FROM clients WHERE workspace_id = ${m.wid}`.catch(() => {});
      await sql`DELETE FROM finance_settings WHERE workspace_id = ${m.wid}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${m.wid}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${m.u}`.catch(() => {});
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
