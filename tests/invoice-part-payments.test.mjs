// Part payments on an invoice add up, are counted once, and settle the
// invoice once they cover what is due (after any gift card).
//
//   [1] Stripe: a short payment is recorded as a part payment; the paired
//       PaymentIntent event for the SAME payment is not counted twice; the
//       pay link then charges only the rest, and paying the rest marks the
//       invoice paid with the full amount collected (it used to stay open
//       forever, overwrite what was collected with the last payment, and
//       ask the client to pay again)
//   [2] a gift card that covers the rest after a part card payment settles
//       the invoice and keeps the card money on record
//   [3] PayPal: part payment, replay of the same capture, then the rest
//   [4] PayPal: a gift card covers part, PayPal pays the remainder, and the
//       invoice is paid (it used to be compared with the full total and
//       stay open)
//   [5] Square: same as [4] through the signed webhook, and payment.created
//       plus payment.updated for one payment count once
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/invoice-part-payments.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_partpay';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_partpay';
process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'sqsig_partpay';
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import invoicePayHandler from '../api/invoice-pay/[token].js';
import giftCardHandler from '../api/invoice-pay/gift-card.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import squareWebhook from '../api/webhooks/square/[workspaceId].js';
import { applyPaymentToInvoice as paypalApply } from '../api/_lib/paypalApply.js';
import { generateCode, normalizeCode, hashCode } from '../api/_lib/giftCards.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const stripeCalls = [];
const paidSessions = new Set();
let csN = 0;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    stripeCalls.push({ url: u, body, headers: init.headers || {} });
    if (/\/checkout\/sessions$/.test(u)) { csN++; return json({ id: `cs_pp_${STAMP}_${csN}`, url: `https://checkout.example/cs_${csN}` }); }
    const got = u.match(/\/checkout\/sessions\/(cs_[^/?]+)(\?|$)/);
    if (got && paidSessions.has(got[1])) {
      const inv = (await sql`SELECT id, workspace_id FROM invoices WHERE stripe_session_id = ${got[1]}`).rows[0];
      return json({ id: got[1], mode: 'payment', status: 'complete', payment_status: 'paid', payment_intent: `pi_for_${got[1]}`,
        amount_total: 5000, payment_method_types: ['card'], metadata: { invoice_id: inv?.id, workspace_id: inv?.workspace_id } });
    }
    return json({});
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
let ipN = 0;
const req = ({ method = 'POST', query = {}, body = {} } = {}) => ({
  method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin: `https://${HOST}`, host: HOST, 'x-forwarded-for': `198.18.77.${++ipN % 250}` },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }

const STAMP = Date.now();
let evtN = 0;
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_pp_${STAMP}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload,
    headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}
async function fireSquare(wid, type, payment) {
  const payload = JSON.stringify({ event_id: `sq_evt_${STAMP}_${++evtN}`, type, data: { object: { payment } } });
  const url = `${process.env.APP_URL.replace(/\/$/, '')}/api/webhooks/square/${wid}`;
  const sig = crypto.createHmac('sha256', process.env.SQUARE_WEBHOOK_SIGNATURE_KEY).update(url + payload).digest('base64');
  const res = mkRes();
  await squareWebhook({ method: 'POST', url: `/api/webhooks/square/${wid}`, query: { workspaceId: wid }, body: payload,
    headers: { 'x-square-hmacsha256-signature': sig, 'content-type': 'application/json' } }, res);
  return res;
}
const sha = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const invRow = (id) => sql`SELECT * FROM invoices WHERE id = ${id}`.then((r) => r.rows[0]);
const made = [];

async function mkBiz(label, finance) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`pp-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await finance(wid);
  const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Casey Client', ${`pp-client-${label}-${STAMP}@example.com`}, 'active') RETURNING id`).rows[0].id;
  made.push({ u, wid });
  return { wid, cid };
}
async function mkInvoice(biz, number, amount) {
  const raw = crypto.randomBytes(24).toString('hex');
  const id = (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, number, status, items, tax_rate, discount, view_token_hash, sent_at, due_date)
    VALUES (${biz.wid}, ${biz.cid}, 'Casey Client', ${number}, 'sent', ${JSON.stringify([{ id: 'li1', description: 'Session', quantity: 1, rate: amount }])}::jsonb, 0, 0, ${sha(raw)}, NOW(), CURRENT_DATE + 14)
    RETURNING id`).rows[0].id;
  return { id, raw };
}
async function mkCard(wid, cents) {
  const raw = generateCode();
  const norm = normalizeCode(raw);
  await sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, status)
    VALUES (${wid}, ${hashCode(norm)}, ${norm.slice(-4)}, ${cents}, ${cents}, 'active')`;
  return raw;
}

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] Stripe: part payment, paired event counted once, the rest settles it');
  const acct = `acct_pp_${STAMP}`;
  const S = await mkBiz('stripe', (wid) => sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status)
    VALUES (${wid}, ${acct}, 'complete')`);
  const inv = await mkInvoice(S, `PP-S-${STAMP}`, 100);
  const pi1 = `pi_pp1_${STAMP}`;
  let r = await fire('checkout.session.completed', {
    id: `cs_pp_a_${STAMP}`, mode: 'payment', payment_status: 'paid', status: 'complete',
    payment_intent: pi1, amount_total: 8000, payment_method_types: ['card'],
    metadata: { invoice_id: inv.id, workspace_id: S.wid },
  }, acct);
  assert(r.body?.result === 'partial-payment', `$80 of $100 is a part payment (${JSON.stringify(r.body)})`);
  r = await fire('payment_intent.succeeded', {
    id: pi1, amount: 8000, amount_received: 8000, payment_method_types: ['card'],
    metadata: { invoice_id: inv.id, workspace_id: S.wid },
  }, acct);
  let row = await invRow(inv.id);
  assert(row.status === 'sent' && Number(row.paid_amount) === 80, `the paired event for the same payment is not counted twice (paid ${row.paid_amount})`);
  assert((row.activity || []).filter((a) => a.kind === 'partial-payment').length === 1, 'one part-payment line on the invoice');

  stripeCalls.length = 0;
  r = await call(invoicePayHandler, req({ query: { token: inv.raw } }));
  const cs = stripeCalls.find((x) => /checkout\/sessions$/.test(x.url));
  assert(r.statusCode === 200 && cs?.body['line_items[0][price_data][unit_amount]'] === '2000', `pay link charges only the $20 left (${cs?.body['line_items[0][price_data][unit_amount]']})`);
  const pi2 = `pi_pp2_${STAMP}`;
  r = await fire('checkout.session.completed', {
    id: `cs_pp_b_${STAMP}`, mode: 'payment', payment_status: 'paid', status: 'complete',
    payment_intent: pi2, amount_total: 2000, payment_method_types: ['card'],
    metadata: { invoice_id: inv.id, workspace_id: S.wid },
  }, acct);
  row = await invRow(inv.id);
  assert(r.body?.result === 'paid' && row.status === 'paid', `paying the last $20 marks the invoice paid (${r.body?.result}, ${row.status})`);
  assert(Number(row.paid_amount) === 100, `paid_amount is everything collected, $100 (${row.paid_amount})`);
  r = await fire('payment_intent.succeeded', {
    id: pi2, amount: 2000, amount_received: 2000, payment_method_types: ['card'],
    metadata: { invoice_id: inv.id, workspace_id: S.wid },
  }, acct);
  row = await invRow(inv.id);
  assert(Number(row.paid_amount) === 100, 'the late paired event changes nothing');

  console.log('\n[2] a gift card covers the rest after a part card payment');
  const inv2 = await mkInvoice(S, `PP-S2-${STAMP}`, 100);
  await fire('checkout.session.completed', {
    id: `cs_pp_c_${STAMP}`, mode: 'payment', payment_status: 'paid', status: 'complete',
    payment_intent: `pi_pp3_${STAMP}`, amount_total: 7000, payment_method_types: ['card'],
    metadata: { invoice_id: inv2.id, workspace_id: S.wid },
  }, acct);
  const code = await mkCard(S.wid, 5000);
  r = await call(giftCardHandler, req({ body: { token: inv2.raw, code, action: 'apply' } }));
  row = await invRow(inv2.id);
  assert(r.body?.paid === true && r.body?.appliedCents === 3000 && row.status === 'paid', `card covers the $30 left and the invoice is paid (${JSON.stringify(r.body)})`);
  assert(Number(row.paid_amount) === 70 && row.paid_method === 'card' && row.stripe_payment_intent === `pi_pp3_${STAMP}`,
    `the $70 card payment stays on record for a refund (${row.paid_amount} ${row.paid_method})`);

  console.log('\n[3] PayPal: part payment, replay, then the rest');
  const P = await mkBiz('paypal', (wid) => sql`INSERT INTO finance_settings (workspace_id, payment_provider, paypal_merchant_id)
    VALUES (${wid}, 'paypal', ${`M-${STAMP}`})`);
  const inv3 = await mkInvoice(P, `PP-P-${STAMP}`, 100);
  const cap1 = { metadata: { invoice_id: inv3.id }, paymentId: `CAP1-${STAMP}`, amountCents: 6000 };
  assert((await paypalApply({ workspaceId: P.wid, parsed: cap1 })) === 'partial-payment', '$60 capture is a part payment');
  await paypalApply({ workspaceId: P.wid, parsed: cap1 });
  row = await invRow(inv3.id);
  assert(Number(row.paid_amount) === 60, `replaying the same capture is not counted twice (${row.paid_amount})`);
  const res3 = await paypalApply({ workspaceId: P.wid, parsed: { metadata: { invoice_id: inv3.id }, paymentId: `CAP2-${STAMP}`, amountCents: 4000 } });
  row = await invRow(inv3.id);
  assert(res3 === 'paid' && row.status === 'paid' && Number(row.paid_amount) === 100, `the $40 rest settles it at $100 (${res3} ${row.status} ${row.paid_amount})`);

  console.log('\n[4] PayPal: gift card part, PayPal pays the remainder');
  const inv4 = await mkInvoice(P, `PP-P2-${STAMP}`, 100);
  const code4 = await mkCard(P.wid, 2500);
  r = await call(giftCardHandler, req({ body: { token: inv4.raw, code: code4, action: 'apply' } }));
  assert(r.body?.remainingCents === 7500, `card applied, $75 left (${JSON.stringify(r.body?.remainingCents)})`);
  const res4 = await paypalApply({ workspaceId: P.wid, parsed: { metadata: { invoice_id: inv4.id }, paymentId: `CAP3-${STAMP}`, amountCents: 7500 } });
  row = await invRow(inv4.id);
  assert(res4 === 'paid' && row.status === 'paid' && Number(row.paid_amount) === 75, `the $75 remainder settles it (${res4} ${row.status} ${row.paid_amount})`);

  console.log('\n[5] Square: gift card part, Square pays the remainder (created + updated count once)');
  const Q = await mkBiz('square', (wid) => sql`INSERT INTO finance_settings (workspace_id, payment_provider, square_merchant_id)
    VALUES (${wid}, 'square', ${`SQM-${STAMP}`})`);
  const inv5 = await mkInvoice(Q, `PP-Q-${STAMP}`, 100);
  const code5 = await mkCard(Q.wid, 4000);
  await call(giftCardHandler, req({ body: { token: inv5.raw, code: code5, action: 'apply' } }));
  const order = `ORD-${STAMP}`;
  await sql`UPDATE invoices SET stripe_session_id = ${order} WHERE id = ${inv5.id}`;
  const pay = { id: `SQP-${STAMP}`, order_id: order, status: 'COMPLETED', amount_money: { amount: 6000, currency: 'USD' } };
  r = await fireSquare(Q.wid, 'payment.created', pay);
  r = await fireSquare(Q.wid, 'payment.updated', pay);
  row = await invRow(inv5.id);
  assert(r.statusCode === 200 && row.status === 'paid' && Number(row.paid_amount) === 60, `the $60 remainder settles it (${row.status} ${row.paid_amount})`);

  const inv6 = await mkInvoice(Q, `PP-Q2-${STAMP}`, 100);
  const order6 = `ORD6-${STAMP}`;
  await sql`UPDATE invoices SET stripe_session_id = ${order6} WHERE id = ${inv6.id}`;
  const pay6 = { id: `SQP6-${STAMP}`, order_id: order6, status: 'COMPLETED', amount_money: { amount: 3000, currency: 'USD' } };
  await fireSquare(Q.wid, 'payment.created', pay6);
  await fireSquare(Q.wid, 'payment.updated', pay6);
  row = await invRow(inv6.id);
  assert(row.status === 'sent' && Number(row.paid_amount) === 30, `one $30 Square payment counts once (${row.paid_amount})`);

  console.log('\n[6] Square: the payment.updated sent for a refund never flips a refunded invoice back to paid');
  const inv7 = await mkInvoice(Q, `PP-Q3-${STAMP}`, 100);
  const order7 = `ORD7-${STAMP}`;
  await sql`UPDATE invoices SET stripe_session_id = ${order7} WHERE id = ${inv7.id}`;
  const pay7 = { id: `SQP7-${STAMP}`, order_id: order7, status: 'COMPLETED', amount_money: { amount: 10000, currency: 'USD' } };
  await fireSquare(Q.wid, 'payment.created', pay7);
  row = await invRow(inv7.id);
  assert(row.status === 'paid' && Number(row.paid_amount) === 100, 'paid in full by Square');
  await sql`UPDATE invoices SET status = 'refunded', refunded_amount = 100, refunded_at = NOW() WHERE id = ${inv7.id}`;
  await fireSquare(Q.wid, 'payment.updated', { ...pay7, refunded_money: { amount: 10000, currency: 'USD' } });
  row = await invRow(inv7.id);
  assert(row.status === 'refunded', `still refunded after the refund's payment.updated (${row.status})`);

  console.log('\n[7] Stripe: a new pay link closes the one it replaces, so one invoice cannot be paid twice');
  const inv8 = await mkInvoice(S, `PP-S3-${STAMP}`, 50);
  stripeCalls.length = 0;
  r = await call(invoicePayHandler, req({ query: { token: inv8.raw } }));
  const first = (await invRow(inv8.id)).stripe_session_id;
  assert(r.statusCode === 200 && /^cs_/.test(first || ''), `first pay link minted (${first})`);
  stripeCalls.length = 0;
  r = await call(invoicePayHandler, req({ query: { token: inv8.raw } }));
  const second = (await invRow(inv8.id)).stripe_session_id;
  const expired = stripeCalls.find((x) => x.url.endsWith(`/checkout/sessions/${first}/expire`));
  assert(r.statusCode === 200 && second && second !== first, 'second pay link minted');
  assert(!!expired && expired.headers?.['Stripe-Account'] === acct, `the first checkout was closed on the connected account (${stripeCalls.map((x) => x.url).join(', ')})`);
  // If the earlier checkout was in fact paid a moment ago, no new one is opened.
  stripeCalls.length = 0;
  paidSessions.add(second);
  r = await call(invoicePayHandler, req({ query: { token: inv8.raw } }));
  row = await invRow(inv8.id);
  assert(!stripeCalls.some((x) => /\/checkout\/sessions$/.test(x.url)), 'no new checkout when the last one was already paid');
  assert(row.status === 'paid' && r.statusCode === 400, `the invoice is marked paid instead (${row.status}, ${r.statusCode} ${JSON.stringify(r.body)})`);

  for (const m of made) {
    await sql`DELETE FROM gift_cards WHERE workspace_id = ${m.wid}`;
    await sql`DELETE FROM invoices WHERE workspace_id = ${m.wid}`;
    await sql`DELETE FROM workspaces WHERE id = ${m.wid}`;
    await sql`DELETE FROM users WHERE id = ${m.u}`;
  }
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});
