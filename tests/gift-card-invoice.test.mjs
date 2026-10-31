// Gift cards redeemed on invoices, end to end through the real handlers.
//
//   [1] a card from workspace A is unknown on workspace B's invoice (check
//       and apply both 404; nothing moves)
//   [2] check shows the balance, what would apply and what would be left
//   [3] a card that covers the whole invoice marks it paid through the
//       shared markInvoicePaid path (paid_method gift_card, receipt email,
//       activity line), writes the redemption row and debits exactly
//   [4] a card that covers part leaves the remainder due, is recorded on
//       the invoice and serialized on the public payload; a second card
//       cannot be applied; the card drains to zero and never below
//   [5] the card Checkout session is minted for the remainder only, and the
//       paid webhook for that remainder marks the invoice paid (not partial)
//   [6] the manual "I've sent it" flow still works on the remainder and the
//       owner's Mark paid records only what they received
//   [7] refunding a mixed invoice in full puts the credit back on the card
//       once; the client's email says so
//   [8] voiding an unpaid invoice with a card applied restores the credit,
//       exactly once
//   [9] refunding a gift-card-only invoice returns the credit, no processor call
//  [10] owner gift card tab counts invoice redemptions; per-IP rate limit;
//       copy rules
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/gift-card-invoice.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_gcinv';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_gcinv';
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { refundInvoice } from '../api/_lib/refunds.js';
import giftCardHandler from '../api/invoice-pay/gift-card.js';
import invoiceViewHandler from '../api/invoice-view/[token].js';
import invoicePayHandler from '../api/invoice-pay/[token].js';
import claimHandler from '../api/invoice-pay/claim.js';
import markPaidHandler from '../api/invoices/mark-paid.js';
import voidHandler from '../api/invoices/void.js';
import ownerListHandler from '../api/gift-cards/index.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const stripeCalls = [];
const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    stripeCalls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body });
    if (/\/checkout\/sessions$/.test(u)) return json({ id: `cs_${stripeCalls.length}`, url: `https://checkout.example/cs_${stripeCalls.length}` });
    if (/\/refunds$/.test(u)) return json({ id: `re_${stripeCalls.length}`, amount: Number(body.amount || 0), status: 'succeeded' });
    if (/\/customers\?/.test(u)) return json({ data: [] });
    if (/\/customers$/.test(u)) return json({ id: `cus_${stripeCalls.length}` });
    return json({});
  }
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  return json({});
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const toList = (e) => (Array.isArray(e?.to) ? e.to : [e?.to]);
const visible = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '');
const noVendor = (s) => !/stripe|square|paypal|resend|business os/i.test(visible(s));
const noEmDash = (s) => !/—/.test(visible(s));

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
const req = ({ method = 'GET', cookie, query = {}, body = {}, ip = '198.18.9.1' } = {}) => ({
  method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin: `https://${HOST}`, host: HOST, 'x-forwarded-for': ip,
    ...(cookie ? { cookie } : {}) },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }
let evtN = 0;
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_gci_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload,
    headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}
const sha = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const STAMP = Date.now();

async function mkBiz(label) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`gci-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `gci-${label}-${STAMP}`.toLowerCase();
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}, biz_name = ${`${label} Studio`}`;
  const acct = `acct_gci_${label}_${STAMP}`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, manual_methods)
    VALUES (${wid}, ${acct}, 'complete', ${JSON.stringify([{ type: 'venmo', handle: '@studio', note: '', enabled: true }])}::jsonb)`;
  const email = `gci-client-${label}-${STAMP}@example.com`;
  const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Casey Client', ${email}, 'active') RETURNING id`).rows[0].id;
  return { userId: u, wid, slug, acct, cid, email, cookie: `ivy_session=${signSession(u)}` };
}
async function mkInvoice(biz, number, amount) {
  const raw = crypto.randomBytes(24).toString('hex');
  const id = (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, client_email, number, status, items, tax_rate, discount, view_token_hash, sent_at, due_date)
    VALUES (${biz.wid}, ${biz.cid}, 'Casey Client', ${biz.email}, ${number}, 'sent', ${JSON.stringify([{ id: 'li1', description: 'Session', quantity: 1, rate: amount }])}::jsonb, 0, 0, ${sha(raw)}, NOW(), CURRENT_DATE + 14)
    RETURNING id`).rows[0].id;
  return { id, raw, number };
}
async function issueCard(biz, amount, sender = `pat-${STAMP}@example.com`) {
  const pi = `pi_gci_${amount}_${++evtN}_${STAMP}`;
  const recipient = `sam-${evtN}-${STAMP}@example.com`;
  const before = emails.length;
  const r = await fire('checkout.session.completed', {
    id: `cs_gci_${evtN}`, mode: 'payment', payment_status: 'paid', status: 'complete', payment_intent: pi, amount_total: amount,
    metadata: { purpose: 'gift_card', workspace_id: biz.wid, amount_cents: String(amount), sender_name: 'Pat Sender', sender_email: sender,
      recipient_name: 'Sam Recipient', recipient_email: recipient },
  }, biz.acct);
  if (r.body?.marked !== 'gift-card-issued') throw new Error(`card not issued: ${JSON.stringify(r.body)}`);
  const mail = emails.slice(before).find((e) => toList(e).includes(recipient));
  const code = (String(mail?.html || '').match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/) || [])[0];
  const row = (await sql`SELECT * FROM gift_cards WHERE stripe_payment_intent = ${pi}`).rows[0];
  return { code, row, pi };
}
const cardRow = (id) => sql`SELECT * FROM gift_cards WHERE id = ${id}`.then((r) => r.rows[0]);
const invRow = (id) => sql`SELECT * FROM invoices WHERE id = ${id}`.then((r) => r.rows[0]);
const gc = (inv, code, action, ip = '198.18.9.2') => call(giftCardHandler, req({ method: 'POST', ip, body: { token: inv.raw, code, action } }));

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('A');
  const B = await mkBiz('B');
  const card = await issueCard(A, 7500);
  assert(!!card.code && Number(card.row.balance_cents) === 7500, 'a $75 card is issued at workspace A');

  console.log('\n[1] a card from workspace A is unknown on workspace B\'s invoice');
  const invB = await mkInvoice(B, 'INV-B1', 50);
  let r = await gc(invB, card.code, 'check');
  assert(r.statusCode === 404, `check on B's invoice → 404 (${r.statusCode})`);
  r = await gc(invB, card.code, 'apply');
  assert(r.statusCode === 404, `apply on B's invoice → 404 (${r.statusCode})`);
  assert(Number((await cardRow(card.row.id)).balance_cents) === 7500 && Number((await invRow(invB.id)).gift_card_credit_cents) === 0, 'nothing moved on either side');
  r = await gc({ raw: 'not-a-real-token-at-all-0000' }, card.code, 'apply');
  assert(r.statusCode === 404, 'bogus token → 404');
  r = await call(giftCardHandler, req({ method: 'POST', body: { token: invB.raw, code: '' } }));
  assert(r.statusCode === 400, 'empty code → 400');

  console.log('\n[2] check shows balance, what applies and what is left');
  const inv1 = await mkInvoice(A, 'INV-A1', 50);
  r = await gc(inv1, card.code, 'check');
  assert(r.statusCode === 200 && r.body.card.balanceCents === 7500 && r.body.card.codeLast4 === card.row.code_last4, `check → balance + last4 (${JSON.stringify(r.body)})`);
  assert(r.body.appliesCents === 5000 && r.body.remainingCents === 0, '$50 invoice: $50 applies, nothing left');
  assert(Object.keys(r.body.card).sort().join(',') === 'balanceCents,codeLast4,expiresAt', 'card payload carries only balance / last4 / expiry');
  assert(Number((await cardRow(card.row.id)).balance_cents) === 7500, 'check debits nothing');

  console.log('\n[3] full cover marks the invoice paid through the shared path');
  emails.length = 0;
  r = await gc(inv1, card.code, 'apply');
  assert(r.statusCode === 200 && r.body.applied === true && r.body.paid === true && r.body.appliedCents === 5000 && r.body.remainingCents === 0, `apply → paid (${JSON.stringify(r.body)})`);
  assert(r.body.giftCard?.codeLast4 === card.row.code_last4 && r.body.giftCard?.balanceLeftCents === 2500, 'response shows the card and what is left on it');
  await settle();
  let i1 = await invRow(inv1.id);
  assert(i1.status === 'paid' && i1.paid_method === 'gift_card' && Number(i1.paid_amount) === 50 && !!i1.paid_at, `invoice paid by gift card, paid_amount $50 (${i1.status}/${i1.paid_method}/${i1.paid_amount})`);
  assert(Number(i1.gift_card_credit_cents) === 5000 && i1.gift_card_id === card.row.id && i1.gift_card_code_last4 === card.row.code_last4, 'credit, card id and last4 recorded on the invoice');
  assert(i1.view_token_hash === null, 'pay link consumed like any other payment');
  assert((i1.activity || []).some((a) => a.kind === 'gift-card') && (i1.activity || []).some((a) => a.kind === 'paid' && /gift card/.test(a.text)), 'activity: gift card applied, then "Paid by gift card" from markInvoicePaid');
  let c = await cardRow(card.row.id);
  assert(Number(c.balance_cents) === 2500 && c.status === 'active', 'card debited exactly $50; $25 left');
  let reds = (await sql`SELECT * FROM gift_card_redemptions WHERE gift_card_id = ${card.row.id} AND applied_to_kind = 'invoice'`).rows;
  assert(reds.length === 1 && Number(reds[0].amount_cents) === 5000 && reds[0].applied_to_id === inv1.id && reds[0].client_id === A.cid && reds[0].workspace_id === A.wid, 'redemption row: kind invoice, exact amount, client, workspace');
  const receipt = emails.find((e) => toList(e).includes(A.email) && /Receipt/.test(e.subject || ''));
  assert(!!receipt && /50\.00/.test(receipt.subject) && /gift card/.test(receipt.html), `client got the receipt from the shared path (${receipt?.subject})`);
  assert(noVendor(receipt?.html) && noEmDash(receipt?.html), 'receipt copy rules');
  r = await gc(inv1, card.code, 'apply');
  assert(r.statusCode === 404, 'the paid invoice no longer accepts a card (token consumed)');
  r = await call(invoiceViewHandler, req({ query: { token: inv1.raw } }));
  assert(r.statusCode === 404, 'public view of the paid invoice is gone');

  console.log('\n[4] partial cover leaves the remainder; never twice; never below zero');
  const inv2 = await mkInvoice(A, 'INV-A2', 100);
  r = await gc(inv2, card.code, 'check');
  assert(r.body.appliesCents === 2500 && r.body.remainingCents === 7500, '$100 invoice with $25 left on the card: $25 applies, $75 remains');
  r = await gc(inv2, card.code, 'apply');
  assert(r.statusCode === 200 && r.body.paid === false && r.body.appliedCents === 2500 && r.body.remainingCents === 7500, `partial apply (${JSON.stringify(r.body).slice(0, 160)})`);
  assert(r.body.invoice?.giftCardCreditCents === 2500 && r.body.invoice?.giftCardCodeLast4 === card.row.code_last4 && r.body.invoice?.status === 'sent', 'public payload carries the applied credit and stays unpaid');
  assert(!('id' in (r.body.invoice || {})) && !('workspaceId' in (r.body.invoice || {})), 'public payload leaks no ids');
  let i2 = await invRow(inv2.id);
  assert(i2.status === 'sent' && Number(i2.gift_card_credit_cents) === 2500 && i2.paid_amount == null, 'invoice stays sent with $25 credit');
  c = await cardRow(card.row.id);
  assert(Number(c.balance_cents) === 0 && c.status === 'depleted', 'card drains to $0 and is depleted, not negative');
  const card2 = await issueCard(A, 1000);
  r = await gc(inv2, card2.code, 'apply');
  assert(r.statusCode === 400 && /already been applied/.test(r.body.error), 'a second card on the same invoice is refused');
  assert(Number((await cardRow(card2.row.id)).balance_cents) === 1000 && Number((await invRow(inv2.id)).gift_card_credit_cents) === 2500, 'the refused attempt moved nothing');
  r = await gc(inv2, card.code, 'check');
  assert(r.statusCode === 400, 'check on an invoice that already has a card → 400');
  r = await call(invoiceViewHandler, req({ query: { token: inv2.raw } }));
  assert(r.statusCode === 200 && r.body.invoice.giftCardCreditCents === 2500 && r.body.invoice.giftCardCodeLast4 === card.row.code_last4 && r.body.invoice.total === 100, 'GET public invoice serializes the credit');

  console.log('\n[5] card Checkout is minted for the remainder; the paid webhook settles it');
  stripeCalls.length = 0;
  r = await call(invoicePayHandler, req({ method: 'POST', query: { token: inv2.raw }, body: {} }));
  assert(r.statusCode === 200 && /^https:\/\/checkout\.example\//.test(r.body.url || ''), `checkout → 200 (${r.statusCode} ${JSON.stringify(r.body)})`);
  const cs = stripeCalls.find((x) => /checkout\/sessions$/.test(x.url));
  assert(cs?.body['line_items[0][price_data][unit_amount]'] === '7500', `Checkout amount equals the remainder $75.00 (${cs?.body['line_items[0][price_data][unit_amount]']})`);
  assert(cs?.headers['Stripe-Account'] === A.acct, 'minted on the connected account');
  emails.length = 0;
  const pi2 = `pi_gci_inv2_${STAMP}`;
  r = await fire('checkout.session.completed', {
    id: cs ? `cs_${stripeCalls.indexOf(cs) + 1}` : 'cs_x', mode: 'payment', payment_status: 'paid', status: 'complete',
    payment_intent: pi2, amount_total: 7500, payment_method_types: ['card'],
    metadata: { invoice_id: inv2.id, workspace_id: A.wid },
  }, A.acct);
  assert(r.statusCode === 200 && r.body.applied === 'invoice-paid' && r.body.result === 'paid', `webhook for $75 marks it paid, not partial (${JSON.stringify(r.body)})`);
  await settle();
  i2 = await invRow(inv2.id);
  assert(i2.status === 'paid' && Number(i2.paid_amount) === 75 && i2.paid_method === 'card' && i2.stripe_payment_intent === pi2, `paid_amount is the $75 collected by card (${i2.paid_amount})`);
  assert(Number(i2.gift_card_credit_cents) === 2500, 'credit stays recorded on the paid invoice');
  const rec2 = emails.find((e) => toList(e).includes(A.email) && /Receipt/.test(e.subject || ''));
  assert(!!rec2 && /75\.00/.test(rec2.subject), 'receipt is for the $75 actually charged');

  console.log('\n[6] manual flow on the remainder; owner Mark paid records what was received');
  const inv3 = await mkInvoice(A, 'INV-A3', 40);
  const card3 = await issueCard(A, 2500);
  r = await gc(inv3, card3.code, 'apply');
  assert(r.statusCode === 200 && r.body.remainingCents === 1500, '$40 invoice, $25 card → $15 remains');
  r = await call(claimHandler, req({ method: 'POST', body: { token: inv3.raw, method: 'venmo' } }));
  assert(r.statusCode === 200 && r.body.ok === true && r.body.method === 'venmo', '"I\'ve sent it" still works with a card applied');
  r = await call(invoiceViewHandler, req({ query: { token: inv3.raw } }));
  assert(r.body.invoice.paymentClaimedMethod === 'venmo' && r.body.invoice.giftCardCreditCents === 2500 && r.body.invoice.manualMethods.length === 1, 'public payload: claim + credit + manual methods together');
  r = await call(markPaidHandler, req({ method: 'POST', cookie: A.cookie, body: { id: inv3.id, method: 'venmo' } }));
  assert(r.statusCode === 200 && r.body.invoice.status === 'paid' && r.body.invoice.paidAmount === 15 && r.body.invoice.giftCardCreditCents === 2500, `owner Mark paid records the $15 received (${r.body.invoice?.paidAmount})`);
  r = await call(markPaidHandler, req({ method: 'POST', cookie: B.cookie, body: { id: inv1.id, method: 'cash' } }));
  assert(r.statusCode === 400, "owner B cannot touch A's invoice");

  console.log('\n[7] refunding a mixed invoice in full restores the credit once');
  stripeCalls.length = 0; emails.length = 0;
  let out = await refundInvoice({ workspaceId: A.wid, id: inv2.id, amount: 25 });
  assert(out.refund.amount === 25 && out.refund.fullyRefunded === false && out.refund.giftRestoredCents === 0, 'partial $25 refund: card money only, credit untouched');
  assert(stripeCalls.filter((x) => /\/refunds$/.test(x.url)).length === 1 && stripeCalls[0].body.amount === '2500', 'processor refund for $25');
  assert(Number((await cardRow(card.row.id)).balance_cents) === 0, 'card still at $0 after a partial refund');
  out = await refundInvoice({ workspaceId: A.wid, id: inv2.id });
  assert(out.refund.amount === 50 && out.refund.fullyRefunded === true && out.refund.giftRestoredCents === 2500, `remaining $50 refund restores the $25 credit (${JSON.stringify(out.refund)})`);
  c = await cardRow(card.row.id);
  assert(Number(c.balance_cents) === 2500 && c.status === 'active', 'card back to $25 and active');
  i2 = await invRow(inv2.id);
  assert(i2.status === 'refunded' && Number(i2.refunded_amount) === 75 && Number(i2.gift_card_credit_restored_cents) === 2500, 'invoice refunded; restored cents recorded');
  assert(out.invoice.giftCardCreditRestoredCents === 2500 && out.invoice.giftCardCreditCents === 2500, 'owner payload shows credit and restored amounts');
  const refundMails = emails.filter((e) => /Refund issued/.test(e.subject || ''));
  assert(refundMails.length === 2, `two refund emails for two refunds (${refundMails.length})`);
  assert(/25\.00 is back on your gift card/.test(refundMails[1]?.html || '') && new RegExp(`ending <strong>${card.row.code_last4}`).test(refundMails[1]?.html || ''), 'full-refund email says the credit is back on the card ending last4');
  assert(/5 to 10 business days/.test(refundMails[1]?.html || ''), 'card part: 5 to 10 business days');
  assert(refundMails.every((e) => noVendor(e.html) && noEmDash(e.html)), 'refund email copy rules');
  let threw = null;
  try { await refundInvoice({ workspaceId: A.wid, id: inv2.id }); } catch (e) { threw = e; }
  assert(!!threw && Number((await cardRow(card.row.id)).balance_cents) === 2500, 'a further refund is refused and restores nothing more');

  console.log('\n[8] voiding an unpaid invoice with a card applied restores the credit once');
  const inv4 = await mkInvoice(A, 'INV-A4', 60);
  r = await gc(inv4, card.code, 'apply');
  assert(r.statusCode === 200 && r.body.appliedCents === 2500 && r.body.remainingCents === 3500, '$25 applied to a $60 invoice');
  assert(Number((await cardRow(card.row.id)).balance_cents) === 0, 'card at $0 again');
  r = await call(voidHandler, req({ method: 'POST', cookie: B.cookie, body: { id: inv4.id } }));
  assert(r.statusCode === 400 && Number((await cardRow(card.row.id)).balance_cents) === 0, "owner B cannot void A's invoice (no credit movement)");
  r = await call(voidHandler, req({ method: 'POST', cookie: A.cookie, body: { id: inv4.id } }));
  assert(r.statusCode === 200 && r.body.invoice.status === 'voided', 'owner A voids');
  c = await cardRow(card.row.id);
  assert(Number(c.balance_cents) === 2500 && c.status === 'active', 'the $25 is back on the card');
  let i4 = await invRow(inv4.id);
  assert(Number(i4.gift_card_credit_restored_cents) === 2500 && (i4.activity || []).some((a) => a.kind === 'gift-card-restored'), 'invoice notes the restore');
  r = await call(voidHandler, req({ method: 'POST', cookie: A.cookie, body: { id: inv4.id } }));
  assert(Number((await cardRow(card.row.id)).balance_cents) === 2500, 'voiding again restores nothing more');
  threw = null;
  try { await refundInvoice({ workspaceId: A.wid, id: inv4.id }); } catch (e) { threw = e; }
  assert(!!threw && Number((await cardRow(card.row.id)).balance_cents) === 2500, 'a voided invoice cannot be refunded; no double restore');

  console.log('\n[9] refunding a gift-card-only invoice returns the credit, no processor call');
  stripeCalls.length = 0; emails.length = 0;
  out = await refundInvoice({ workspaceId: A.wid, id: inv1.id, amount: 20 });
  assert(out.refund.method === 'gift_card' && out.refund.amount === 20 && out.refund.giftRestoredCents === 2000 && out.refund.fullyRefunded === false, `partial $20 goes back on the card (${JSON.stringify(out.refund)})`);
  assert(stripeCalls.length === 0, 'no processor call');
  assert(Number((await cardRow(card.row.id)).balance_cents) === 4500, 'card: $25 + $20 = $45');
  assert(emails.length === 1 && /gift card/.test(emails[0].html) && !/5 to 10 business days/.test(emails[0].html), 'email: credit is back on the card, no bank-days line');
  out = await refundInvoice({ workspaceId: A.wid, id: inv1.id });
  assert(out.refund.amount === 30 && out.refund.fullyRefunded === true && out.refund.giftRestoredCents === 3000, 'the remaining $30 goes back too');
  assert(Number((await cardRow(card.row.id)).balance_cents) === 7500, 'card is whole again at $75');
  i1 = await invRow(inv1.id);
  assert(i1.status === 'refunded' && Number(i1.gift_card_credit_restored_cents) === 5000, 'invoice refunded; all credit restored');

  console.log('\n[10] owner tab counts invoice redemptions; rate limit; copy');
  r = await call(ownerListHandler, req({ cookie: A.cookie }));
  assert(r.statusCode === 200 && r.body.redemptions.invoices.count === 4 && r.body.redemptions.invoices.cents === 12500, `4 invoice redemptions totalling $125 (${JSON.stringify(r.body.redemptions)})`);
  assert(r.body.redemptions.bookings.count === 0, 'no booking redemptions in this run');
  r = await call(ownerListHandler, req({ cookie: B.cookie }));
  assert(r.body.cards.length === 0 && r.body.redemptions.invoices.count === 0, "owner B sees none of A's cards or redemptions");
  const inv5 = await mkInvoice(A, 'INV-A5', 10);
  let limited = null;
  for (let i = 0; i < 31 && !limited; i++) {
    const rr = await gc(inv5, 'ZZZZ-ZZZZ-ZZZZ', 'check', '198.18.9.99');
    if (rr.statusCode === 429) limited = i + 1;
  }
  assert(limited === 31, `31st gift card check from one IP in an hour is rate limited (hit at ${limited})`);
  const everything = emails.map((e) => e.subject + e.html).join('\n');
  assert(noVendor(everything) && noEmDash(everything), 'no vendor names, no em dashes, never "business OS" in any client email');

  for (const w of [A, B]) {
    await sql`DELETE FROM gift_cards WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM invoices WHERE workspace_id = ${w.wid}`;
    await sql`DELETE FROM workspaces WHERE id = ${w.wid}`;
    await sql`DELETE FROM users WHERE id = ${w.userId}`;
  }
  await sql`DELETE FROM rate_limits WHERE key LIKE 'invgc:%'`.catch(() => {});
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});
