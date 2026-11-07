// What a client still owes is the total minus what they have NET paid
// (paid minus refunded), everywhere it is worked out: the pay link, the
// public invoice, reminders, autopay, gift cards and the owner's numbers.
//
//   [1] a part payment refunded on a still-open invoice is owed again: the
//       pay link asks for the full $100 (it used to ask for $40); paying it
//       settles the invoice and a refund can give back only that $100
//   [2] a fully paid then fully refunded invoice stays refunded and cannot
//       be paid again
//   [3] a part refund of a part payment: $60 paid, $20 back, $60 owed
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/invoice-net-due.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_netdue';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_netdue';
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { refundInvoice } from '../api/_lib/refunds.js';
import { invoiceDueCents } from '../api/_lib/giftCards.js';
import { balanceDueCents } from '../api/_lib/autopay.js';
import { reminderOwed } from '../api/_lib/invoiceNotify.js';
import { invoicePaymentState } from '../api/_lib/invoicePayments.js';
import invoicePayHandler from '../api/invoice-pay/[token].js';
import invoiceViewHandler from '../api/invoice-view/[token].js';
import platformWebhook from '../api/webhooks/stripe-platform.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const STAMP = Date.now();
const sessions = [];
let refundN = 0;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com\/v1\/refunds/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    return json({ id: `re_nd_${STAMP}_${++refundN}`, amount: Number(body.amount), status: 'succeeded' });
  }
  if (/api\.stripe\.com\/v1\/checkout\/sessions$/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    sessions.push(body);
    return json({ id: `cs_nd_${STAMP}_${sessions.length}`, url: `https://checkout.example/${sessions.length}` });
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
const HOST = 'www.joinivy.ai';
let ipN = 0;
const req = ({ method = 'POST', query = {}, body = {} } = {}) => ({
  method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin: `https://${HOST}`, host: HOST, 'x-forwarded-for': `198.18.93.${++ipN % 250}` },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }
let evtN = 0;
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_nd_${STAMP}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload,
    headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}
const sha = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const invRow = (id) => sql`SELECT * FROM invoices WHERE id = ${id}`.then((r) => r.rows[0]);
const num = (v) => Number(v || 0);

let uid, wid, cid;
const acct = `acct_nd_${STAMP}`;
async function mkInvoice(number, amount) {
  const raw = crypto.randomBytes(24).toString('hex');
  const id = (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, number, status, items, tax_rate, discount, view_token_hash, sent_at, due_date)
    VALUES (${wid}, ${cid}, 'Casey Client', ${number}, 'sent', ${JSON.stringify([{ id: 'li1', description: 'Session', quantity: 1, rate: amount }])}::jsonb, 0, 0, ${sha(raw)}, NOW(), CURRENT_DATE + 14)
    RETURNING id`).rows[0].id;
  return { id, raw };
}
const pay = (inv, pi, cents) => fire('checkout.session.completed', {
  id: `cs_paid_${pi}`, mode: 'payment', payment_status: 'paid', status: 'complete',
  payment_intent: pi, amount_total: cents, payment_method_types: ['card'],
  metadata: { invoice_id: inv.id, workspace_id: wid },
}, acct);
const linkAmount = async (inv) => {
  sessions.length = 0;
  const r = await call(invoicePayHandler, req({ query: { token: inv.raw } }));
  return { status: r.statusCode, cents: sessions[0] ? Number(sessions[0]['line_items[0][price_data][unit_amount]']) : null, body: r.body };
};

async function run() {
  await ensureSchemaApplied();
  uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`nd-${STAMP}@example.com`}, 'x', 'Owner', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, 'Net Studio', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status) VALUES (${wid}, ${acct}, 'complete')`;
  cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Casey Client', ${`nd-client-${STAMP}@example.com`}, 'active') RETURNING id`).rows[0].id;

  console.log('\n[1] a refunded part payment is owed again');
  const a = await mkInvoice(`ND-A-${STAMP}`, 100);
  await pay(a, `pi_nd_a1_${STAMP}`, 6000);
  await refundInvoice({ workspaceId: wid, id: a.id, amount: 60 });
  let row = await invRow(a.id);
  assert(row.status === 'sent' && num(row.paid_amount) === 60 && num(row.refunded_amount) === 60, `still open, $60 paid and $60 refunded (${row.status})`);
  assert(invoiceDueCents(row) === 10000, `gift card / due helper: $100 owed (${invoiceDueCents(row)})`);
  assert(balanceDueCents(row) === 10000, `autopay: $100 owed (${balanceDueCents(row)})`);
  assert(reminderOwed(row) === 100, `reminders: $100 owed (${reminderOwed(row)})`);
  assert(invoicePaymentState(row).due === 100 && invoicePaymentState(row, { amountCents: 4000 }).underpaid === true,
    'a $40 payment would not settle it');
  let v = await call(invoiceViewHandler, req({ method: 'GET', query: { token: a.raw } }));
  const owedShown = v.body?.invoice?.money?.owed ?? v.body?.invoice?.amountDue;
  assert(v.statusCode === 200 && owedShown === 100, `public invoice shows $100 owed (${owedShown})`);
  let link = await linkAmount(a);
  assert(link.status === 200 && link.cents === 10000, `pay link charges $100, not $40 (${link.status} ${link.cents})`);
  await pay(a, `pi_nd_a2_${STAMP}`, 10000);
  row = await invRow(a.id);
  assert(row.status === 'paid' && num(row.paid_amount) === 160 && num(row.refunded_amount) === 60, `paying $100 settles it (${row.status} ${row.paid_amount})`);
  const out = await refundInvoice({ workspaceId: wid, id: a.id });
  row = await invRow(a.id);
  assert(out.refund.amount === 100 && row.status === 'refunded' && num(row.refunded_amount) === 160, `refund gives back the $100 kept, then refunded (${out.refund.amount} ${row.status})`);

  console.log('\n[2] fully paid, fully refunded: stays refunded, not payable');
  const b = await mkInvoice(`ND-B-${STAMP}`, 50);
  await pay(b, `pi_nd_b_${STAMP}`, 5000);
  await refundInvoice({ workspaceId: wid, id: b.id });
  row = await invRow(b.id);
  assert(row.status === 'refunded' && invoiceDueCents({ ...row, status: 'refunded' }) >= 0 && balanceDueCents(row) === 0 && reminderOwed(row) === 0,
    `refunded, nothing owed anywhere (${row.status})`);
  link = await linkAmount(b);
  assert(link.status >= 400 && sessions.length === 0, `pay link refused, no checkout opened (${link.status})`);
  await sql`UPDATE invoices SET view_token_hash = ${sha(b.raw)} WHERE id = ${b.id}`;
  link = await linkAmount(b);
  assert(link.status >= 400 && sessions.length === 0, `even with a live link token, a refunded invoice cannot be paid (${link.status})`);

  console.log('\n[3] part refund of a part payment');
  const c = await mkInvoice(`ND-C-${STAMP}`, 100);
  await pay(c, `pi_nd_c_${STAMP}`, 6000);
  await refundInvoice({ workspaceId: wid, id: c.id, amount: 20 });
  row = await invRow(c.id);
  assert(invoiceDueCents(row) === 6000 && balanceDueCents(row) === 6000 && reminderOwed(row) === 60, `$60 owed (${invoiceDueCents(row)})`);
  link = await linkAmount(c);
  assert(link.cents === 6000, `pay link charges $60 (${link.cents})`);
}

run()
  .catch((err) => { console.error('Fatal:', err.message, err.stack); fail++; })
  .finally(async () => {
    if (wid) {
      await sql`DELETE FROM invoice_payments WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM invoices WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM clients WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM finance_settings WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${wid}`.catch(() => {});
    }
    if (uid) await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
