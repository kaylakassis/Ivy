// Square and PayPal refunds reported after the fact.
//
//   [1] a Square refund that later FAILS (or is REJECTED) at Square is taken
//       back off the payment and the invoice (a refunded invoice is paid
//       again), the owner is told plainly, once; a late "completed" for the
//       same refund never counts it again
//   [2] a refund the provider answers with FAILED / CANCELLED straight
//       away is not recorded as refunded
//   [3] Square and PayPal dashboard refunds email the client like Stripe
//       dashboard refunds do, once per refund; the provider's notice of a
//       refund made in Ivy sends nothing more
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/provider-refund-events.test.mjs
import crypto from 'node:crypto';
process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'sqsig_pre';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.PAYPAL_CLIENT_ID ||= 'pp_client_pre';
process.env.PAYPAL_CLIENT_SECRET ||= 'pp_secret_pre';
process.env.APP_URL ||= 'https://www.joinivy.ai';
process.env.RESEND_API_KEY ||= 're_test_not_real';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { encrypt } from '../api/_lib/secrets.js';
import { refundInvoice } from '../api/_lib/refunds.js';
import squareWebhook from '../api/webhooks/square/[workspaceId].js';
import { applyPaymentToInvoice as paypalApply, applyRefundToInvoice as paypalRefund } from '../api/_lib/paypalApply.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const STAMP = Date.now();
let refundN = 0;
let squareStatus = 'PENDING';
let paypalStatus = 'COMPLETED';
const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/squareup(sandbox)?\.com\/v2\/refunds/.test(u)) {
    const body = JSON.parse(String(init.body || '{}'));
    return json({ refund: { id: `SQR-${STAMP}-${++refundN}`, amount_money: body.amount_money, status: squareStatus } });
  }
  if (/paypal\.com\/v1\/oauth2\/token/.test(u)) return json({ access_token: 'pp_tok', expires_in: 32400 });
  if (/paypal\.com\/v2\/payments\/captures\/[^/]+\/refund/.test(u)) {
    const body = JSON.parse(String(init.body || '{}'));
    return json({ id: `PPR-${STAMP}-${++refundN}`, amount: body.amount, status: paypalStatus });
  }
  if (/resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  return json({});
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
let evtN = 0;
async function fireSquare(wid, type, object) {
  const payload = JSON.stringify({ event_id: `sq_pre_${STAMP}_${++evtN}`, type, data: { object } });
  const url = `${process.env.APP_URL.replace(/\/$/, '')}/api/webhooks/square/${wid}`;
  const sig = crypto.createHmac('sha256', process.env.SQUARE_WEBHOOK_SIGNATURE_KEY).update(url + payload).digest('base64');
  const res = mkRes();
  await squareWebhook({ method: 'POST', url: `/api/webhooks/square/${wid}`, query: { workspaceId: wid }, body: payload,
    headers: { 'x-square-hmacsha256-signature': sig, 'content-type': 'application/json' } }, res);
  return res;
}
const invRow = (id) => sql`SELECT * FROM invoices WHERE id = ${id}`.then((r) => r.rows[0]);
const ledger = (id) => sql`SELECT * FROM invoice_payments WHERE invoice_id = ${id} ORDER BY created_at ASC, id ASC`.then((r) => r.rows);
const num = (v) => Number(v || 0);
const toList = (e) => (Array.isArray(e?.to) ? e.to : [e?.to]);
const refundMails = (to) => emails.filter((e) => /Refund issued/.test(e.subject || '') && toList(e).includes(to));
const pushes = (wid, re) => sql`SELECT title, body FROM notifications WHERE workspace_id = ${wid} ORDER BY created_at ASC`.then((r) => r.rows.filter((n) => re.test(`${n.title} ${n.body}`)));
const settle = () => new Promise((r) => setTimeout(r, 60));

const made = [];
async function mkBiz(label, finance) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`pre-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await finance(wid);
  const email = `pre-client-${label}-${STAMP}@example.com`;
  const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Robin Client', ${email}, 'active') RETURNING id`).rows[0].id;
  made.push({ u, wid });
  return { wid, cid, email };
}
async function mkInvoice(biz, number, amount, order = null) {
  return (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, client_email, number, status, items, tax_rate, discount, sent_at, due_date, stripe_session_id)
    VALUES (${biz.wid}, ${biz.cid}, 'Robin Client', ${biz.email}, ${number}, 'sent',
            ${JSON.stringify([{ id: 'li1', description: 'Session', quantity: 1, rate: amount }])}::jsonb, 0, 0, NOW(), CURRENT_DATE + 14, ${order})
    RETURNING id`).rows[0].id;
}

async function run() {
  await ensureSchemaApplied();
  const Q = await mkBiz('square', (wid) => sql`INSERT INTO finance_settings (workspace_id, payment_provider, square_merchant_id, square_credentials_encrypted)
    VALUES (${wid}, 'square', ${`SQM-PRE-${STAMP}`}, ${encrypt(JSON.stringify({ access_token: 'sq_tok' }))})`);

  console.log('\n[1] a Square refund that fails later is taken back');
  const order = `ORD-PRE-${STAMP}`;
  const inv = await mkInvoice(Q, `PRE-Q1-${STAMP}`, 100, order);
  const p1 = { id: `SQP-PRE1-${STAMP}`, order_id: order, status: 'COMPLETED', amount_money: { amount: 10000, currency: 'USD' } };
  await fireSquare(Q.wid, 'payment.created', { payment: p1 });
  emails.length = 0;
  const out = await refundInvoice({ workspaceId: Q.wid, id: inv });
  let row = await invRow(inv);
  assert(row.status === 'refunded' && num(row.refunded_amount) === 100, 'Ivy refund recorded (Square said PENDING)');
  const rid = out.refund.stripeRefundId;
  const failed = { id: rid, payment_id: p1.id, status: 'FAILED', amount_money: { amount: 10000, currency: 'USD' } };
  let w = await fireSquare(Q.wid, 'refund.updated', { refund: failed });
  await settle();
  row = await invRow(inv);
  let led = await ledger(inv);
  assert(w.statusCode === 200 && row.status === 'paid' && num(row.refunded_amount) === 0 && num(led[0].refunded_amount) === 0,
    `taken back: invoice paid again, nothing refunded (${row.status} ${row.refunded_amount} / ${led[0].refunded_amount})`);
  assert((row.activity || []).some((a) => /failed at Square/.test(a.text || '')), 'the invoice notes the failed refund');
  let ps = await pushes(Q.wid, /failed at Square/);
  assert(ps.length === 1 && ps[0].body === 'The $100.00 refund to Robin Client failed at Square. The money was not returned.',
    `owner told plainly (${ps[0]?.body})`);
  await fireSquare(Q.wid, 'refund.updated', { refund: failed });
  await settle();
  row = await invRow(inv);
  ps = await pushes(Q.wid, /failed at Square/);
  assert(num(row.refunded_amount) === 0 && ps.length === 1, 'the same failure again changes nothing and tells no one twice');
  await fireSquare(Q.wid, 'refund.updated', { refund: { ...failed, status: 'COMPLETED' } });
  row = await invRow(inv);
  assert(num(row.refunded_amount) === 0 && row.status === 'paid', 'a late "completed" for the failed refund is not counted');
  // A refund that is REJECTED behaves the same.
  const out2 = await refundInvoice({ workspaceId: Q.wid, id: inv, amount: 40 });
  await fireSquare(Q.wid, 'refund.updated', { refund: { id: out2.refund.stripeRefundId, payment_id: p1.id, status: 'REJECTED', amount_money: { amount: 4000, currency: 'USD' } } });
  row = await invRow(inv);
  assert(num(row.refunded_amount) === 0, `a rejected refund is taken back too (${row.refunded_amount})`);

  console.log('\n[2] refused straight away: not recorded');
  squareStatus = 'FAILED';
  let threw = null;
  try { await refundInvoice({ workspaceId: Q.wid, id: inv, amount: 10 }); } catch (e) { threw = e; }
  squareStatus = 'PENDING';
  row = await invRow(inv);
  assert(!!threw && /did not go through|failed/i.test(threw.message) && num(row.refunded_amount) === 0, `Square FAILED answer: error, nothing recorded (${threw?.message})`);

  console.log('\n[3] dashboard refunds email the client once');
  emails.length = 0;
  const dash = { id: `SQDASH-PRE-${STAMP}`, payment_id: p1.id, status: 'COMPLETED', amount_money: { amount: 2500, currency: 'USD' } };
  await fireSquare(Q.wid, 'refund.updated', { refund: dash });
  await fireSquare(Q.wid, 'refund.updated', { refund: dash });
  await settle();
  let mails = refundMails(Q.email);
  assert(mails.length === 1 && /\$25\.00/.test(mails[0].subject), `Square dashboard refund: one email for $25 (${mails.length})`);
  emails.length = 0;
  const own = await refundInvoice({ workspaceId: Q.wid, id: inv, amount: 10 });
  await fireSquare(Q.wid, 'refund.updated', { refund: { id: own.refund.stripeRefundId, payment_id: p1.id, status: 'COMPLETED', amount_money: { amount: 1000, currency: 'USD' } } });
  await settle();
  mails = refundMails(Q.email);
  assert(mails.length === 1, `a refund made in Ivy: one email, none from Square's notice (${mails.length})`);

  const P = await mkBiz('paypal', (wid) => sql`INSERT INTO finance_settings (workspace_id, payment_provider, paypal_merchant_id)
    VALUES (${wid}, 'paypal', ${`M-PRE-${STAMP}`})`);
  const pinv = await mkInvoice(P, `PRE-P1-${STAMP}`, 80);
  await paypalApply({ workspaceId: P.wid, parsed: { metadata: { invoice_id: pinv }, paymentId: `CAP-PRE-${STAMP}`, amountCents: 8000 } });
  emails.length = 0;
  const ppDash = { paymentId: `CAP-PRE-${STAMP}`, refundId: `PPDASH-PRE-${STAMP}`, amountCents: 3000 };
  await paypalRefund({ workspaceId: P.wid, parsed: ppDash });
  await paypalRefund({ workspaceId: P.wid, parsed: ppDash });
  await settle();
  mails = refundMails(P.email);
  assert(mails.length === 1 && /\$30\.00/.test(mails[0].subject), `PayPal dashboard refund: one email for $30 (${mails.length})`);
  paypalStatus = 'FAILED';
  threw = null;
  try { await refundInvoice({ workspaceId: P.wid, id: pinv, amount: 10 }); } catch (e) { threw = e; }
  paypalStatus = 'COMPLETED';
  row = await invRow(pinv);
  assert(!!threw && num(row.refunded_amount) === 30, `PayPal FAILED answer: error, nothing more recorded (${row.refunded_amount})`);
}

run()
  .catch((err) => { console.error('Fatal:', err.message, err.stack); fail++; })
  .finally(async () => {
    for (const m of made) {
      await sql`DELETE FROM notifications WHERE workspace_id = ${m.wid}`.catch(() => {});
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
