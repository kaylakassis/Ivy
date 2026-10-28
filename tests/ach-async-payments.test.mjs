// ACH Direct Debit through Stripe Checkout (dynamic payment methods).
// Stripe reports checkout.session.completed with payment_status 'unpaid'
// while the debit settles (up to 4 business days), then sends
// checkout.session.async_payment_succeeded or _failed.
//
//   [1] completed + unpaid → invoice stays open, "payment processing" is
//       recorded, owner is told; duplicate delivery is a no-op
//   [2] public page: confirm reports processing (not paid); view hides Pay
//   [3] async_payment_succeeded → paid via the same fulfilment as a card
//       payment (paid_method 'ach'); duplicate is a no-op
//   [4] async_payment_failed → unpaid, processing cleared, owner + client
//       notified with a pay-again link; duplicate is a no-op
//   [5] payment_intent.succeeded safety net also settles a processing invoice
//   [6] unpaid completed sessions never fulfil gift cards / packages
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/ach-async-payments.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_ach';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_ach';
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import payHandler from '../api/invoice-pay/[token].js';
import viewHandler from '../api/invoice-view/[token].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  return json({});
};

// Owner/client mails are fire-and-forget inside fulfilment; give them a beat.
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s; return this; },
  };
}
const hdrs = (extra = {}) => ({ host: 'www.joinivy.ai', origin: 'https://www.joinivy.ai', 'user-agent': 'test', 'x-forwarded-for': '198.18.3.3', ...extra });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let evtN = 0;
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_ach_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}
const invRow = (id) => sql`SELECT * FROM invoices WHERE id = ${id}`.then((r) => r.rows[0]);

async function run() {
  await ensureSchemaApplied();
  const tag = `ach-${Date.now()}`;
  const acct = `acct_${tag}`;
  const owner = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
    VALUES (${`${tag}-owner@example.com`}, 'x', 'Olive Owner', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${owner}, 'ACH Studio', 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, 'ACH Studio', ${`ach-${Date.now()}`})`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status) VALUES (${wid}, ${acct}, 'complete')`;
  const clientEmail = `${tag}-client@example.com`;
  const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Casey Client', ${clientEmail}, 'active') RETURNING id`).rows[0].id;
  const mkInvoice = async (number, amount) => {
    const raw = crypto.randomBytes(24).toString('hex');
    const id = (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, client_email, number, status, items, tax_rate, discount, view_token_hash, sent_at)
      VALUES (${wid}, ${cid}, 'Casey Client', ${clientEmail}, ${number}, 'sent', ${JSON.stringify([{ id: 'li1', description: 'Session', quantity: 1, rate: amount }])}::jsonb, 0, 0, ${sha(raw)}, NOW())
      RETURNING id`).rows[0].id;
    return { id, raw };
  };
  const session = (inv, extra = {}) => ({
    id: `cs_${inv.id.slice(0, 8)}`, mode: 'payment', status: 'complete', payment_status: 'unpaid',
    amount_total: 20000, payment_intent: `pi_${inv.id.slice(0, 8)}`,
    payment_method_types: ['card', 'us_bank_account'],
    success_url: `https://www.joinivy.ai/invoice/${inv.raw}?paid=1`,
    metadata: { invoice_id: inv.id, workspace_id: wid },
    ...extra,
  });

  console.log('\n[1] completed + unpaid (ACH) → processing, not paid');
  const inv1 = await mkInvoice('INV-ACH-1', 200);
  emails.length = 0;
  let r = await fire('checkout.session.completed', session(inv1), acct);
  assert(r.statusCode === 200 && r.body?.applied === 'invoice-processing' && r.body?.result === 'processing', `webhook records processing (got ${JSON.stringify(r.body)})`);
  let row = await invRow(inv1.id);
  assert(row.status === 'sent' && !row.paid_at, 'invoice is NOT marked paid');
  assert(!!row.payment_processing_at && row.payment_processing_method === 'ach', 'payment_processing_at + method stamped');
  assert(row.activity.some((a) => a.kind === 'payment-processing'), 'activity shows "Bank payment started"');
  assert(row.stripe_session_id === `cs_${inv1.id.slice(0, 8)}`, 'session id recorded for later reconciliation');
  await settle();
  assert(emails.some((e) => /Bank payment started/.test(e.subject || '') && (e.to || []).includes(`${tag}-owner@example.com`)), 'owner emailed that a bank payment is on its way');
  assert(!emails.some((e) => /Receipt/.test(e.subject || '')), 'no receipt sent yet');
  r = await fire('checkout.session.completed', session(inv1), acct);
  assert(r.statusCode === 200 && r.body?.result === 'already-processing', 'duplicate completed delivery is a no-op');
  row = await invRow(inv1.id);
  assert(row.activity.filter((a) => a.kind === 'payment-processing').length === 1, 'no duplicate activity line');

  console.log('\n[2] public page reports processing instead of paid');
  let res = mkRes();
  await payHandler({ method: 'POST', headers: hdrs(), query: { token: inv1.raw, action: 'confirm' }, body: {} }, res);
  assert(res.statusCode === 200 && res.body?.paid === false && res.body?.processing === true, `confirm → { paid:false, processing:true } (got ${JSON.stringify(res.body)})`);
  res = mkRes();
  await viewHandler({ method: 'GET', headers: hdrs(), query: { token: inv1.raw } }, res);
  assert(res.statusCode === 200 && !!res.body?.invoice?.paymentProcessingAt, 'invoice view carries paymentProcessingAt');
  assert(res.body?.invoice?.paymentEnabled === false, 'Pay button is hidden while the debit settles');
  res = mkRes();
  await payHandler({ method: 'POST', headers: hdrs(), query: { token: inv1.raw }, body: {} }, res);
  assert(res.statusCode === 400 && /on its way/.test(res.body?.error || ''), 'a second payment attempt is refused while processing');

  console.log('\n[3] async_payment_succeeded → paid through the shared path');
  emails.length = 0;
  r = await fire('checkout.session.async_payment_succeeded', session(inv1, { payment_status: 'paid' }), acct);
  assert(r.statusCode === 200 && r.body?.applied === 'invoice-paid' && r.body?.result === 'paid', `settled → invoice-paid (got ${JSON.stringify(r.body)})`);
  row = await invRow(inv1.id);
  assert(row.status === 'paid' && !!row.paid_at && Number(row.paid_amount) === 200, 'invoice paid for the settled amount');
  assert(row.paid_method === 'ach', 'paid_method records ACH');
  assert(row.payment_processing_at === null && row.payment_processing_method === null, 'processing flag cleared');
  assert(row.view_token_hash === null, 'pay link consumed');
  await settle();
  assert(emails.some((e) => /Receipt: invoice INV-ACH-1/.test(e.subject || '')), 'client receipt sent on settlement, same as a card payment');
  const paidLines = row.activity.filter((a) => a.kind === 'paid').length;
  r = await fire('checkout.session.async_payment_succeeded', session(inv1, { payment_status: 'paid' }), acct);
  assert(r.statusCode === 200 && r.body?.result === 'already-paid', 'duplicate async_payment_succeeded is a no-op');
  row = await invRow(inv1.id);
  assert(row.activity.filter((a) => a.kind === 'paid').length === paidLines && paidLines === 1, 'exactly one "paid" activity line');

  console.log('\n[4] async_payment_failed → open again, both sides told');
  const inv2 = await mkInvoice('INV-ACH-2', 200);
  await fire('checkout.session.completed', session(inv2), acct);
  row = await invRow(inv2.id);
  assert(!!row.payment_processing_at, 'second invoice is processing');
  emails.length = 0;
  r = await fire('checkout.session.async_payment_failed', session(inv2), acct);
  assert(r.statusCode === 200 && r.body?.result === 'failed-recorded', `failure recorded (got ${JSON.stringify(r.body)})`);
  row = await invRow(inv2.id);
  assert(row.status === 'sent' && !row.paid_at, 'invoice stays unpaid');
  assert(row.payment_processing_at === null, 'processing flag cleared');
  assert(row.activity.some((a) => a.kind === 'payment-failed'), 'activity shows the failed bank payment');
  const ownerMail = emails.find((e) => /Bank payment failed/.test(e.subject || ''));
  const clientMail = emails.find((e) => /Payment failed for invoice INV-ACH-2/.test(e.subject || ''));
  assert(!!ownerMail && (ownerMail.to || []).includes(`${tag}-owner@example.com`), 'owner emailed about the failure');
  assert(!!clientMail && (clientMail.to || []).includes(clientEmail), 'client emailed about the failure');
  assert((clientMail?.html || '').includes(`/invoice/${inv2.raw}`), 'client email carries the pay-again link (same token)');
  assert(row.view_token_hash === sha(inv2.raw), 'existing pay link still valid');
  res = mkRes();
  await viewHandler({ method: 'GET', headers: hdrs(), query: { token: inv2.raw } }, res);
  assert(res.statusCode === 200 && res.body?.invoice?.paymentEnabled === true && !res.body.invoice.paymentProcessingAt, 'invoice page offers Pay again');
  emails.length = 0;
  r = await fire('checkout.session.async_payment_failed', session(inv2), acct);
  assert(r.statusCode === 200 && r.body?.result === 'already-recorded', 'duplicate async_payment_failed is a no-op');
  assert(emails.length === 0, 'no second round of failure emails');

  console.log('\n[5] payment_intent.succeeded also settles a processing invoice');
  const inv3 = await mkInvoice('INV-ACH-3', 200);
  await fire('checkout.session.completed', session(inv3), acct);
  r = await fire('payment_intent.succeeded', {
    id: `pi_${inv3.id.slice(0, 8)}`, amount: 20000, amount_received: 20000,
    payment_method_types: ['us_bank_account'],
    metadata: { invoice_id: inv3.id, workspace_id: wid },
  }, acct);
  assert(r.statusCode === 200 && r.body?.result === 'paid', `safety net marks paid (got ${JSON.stringify(r.body)})`);
  row = await invRow(inv3.id);
  assert(row.status === 'paid' && row.paid_method === 'ach' && row.payment_processing_at === null, 'paid by ACH, processing cleared');

  console.log('\n[6] unpaid completed sessions never fulfil other purchases');
  const before = (await sql`SELECT COUNT(*)::int n FROM gift_cards WHERE workspace_id = ${wid}`).rows[0].n;
  r = await fire('checkout.session.completed', {
    id: 'cs_gift_unpaid', mode: 'payment', status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_gift_unpaid',
    metadata: { workspace_id: wid, purpose: 'gift_card', amount_cents: '5000', recipient_email: 'r@example.com' },
  }, acct);
  assert(r.statusCode === 200 && /awaiting settlement/.test(r.body?.ignored || ''), 'unpaid gift card session is ignored');
  assert((await sql`SELECT COUNT(*)::int n FROM gift_cards WHERE workspace_id = ${wid}`).rows[0].n === before, 'no gift card issued before the money clears');
  r = await fire('checkout.session.completed', {
    id: 'cs_pkg_unpaid', mode: 'payment', status: 'complete', payment_status: 'unpaid',
    metadata: { workspace_id: wid, purpose: 'package', package_id: '00000000-0000-4000-8000-000000000000', client_id: cid },
  }, acct);
  assert(r.statusCode === 200 && /awaiting settlement/.test(r.body?.ignored || ''), 'unpaid package session is ignored');
  assert((await sql`SELECT COUNT(*)::int n FROM client_packages WHERE workspace_id = ${wid}`).rows[0].n === 0, 'no package provisioned');

  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${owner}`;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
