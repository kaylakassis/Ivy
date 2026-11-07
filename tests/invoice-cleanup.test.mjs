// Invoice clean-up: delete, void, refund, archive, and the money every
// screen shows afterwards (src/lib/invoiceRules.js is the single rule
// book; api/_lib/invoiceActions.js enforces it on the server).
//
//   [1] each status x each action: allowed or refused with a clear message
//   [2] void stops the pay link (public page says voided, pay / claim /
//       gift card refused) and the client can be emailed once on request
//   [3] delete only removes never-sent drafts; billed time is released
//   [4] part payment: void refused until the payment is refunded
//   [5] paid -> partial refund -> full refund -> archive: amounts in API
//       responses, Finance totals, workspace_revenue, client portal,
//       public page, accounting + tax exports; archive never moves revenue
//   [6] archive list / filter / counts / bulk with skips
//   [7] reminders: overdue + due-soon crons never email void, paid,
//       archived, settling or fully covered invoices; amounts are what is
//       owed
//   [8] Ivy: approval gate for void / delete / refund / archive, truthful
//       ledger, refusals in plain words, search shows allowed actions
//   [9] workspace isolation for every action
//  [10] Dashboard refund from the older per-workspace Stripe webhook now
//       updates the invoice
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/invoice-cleanup.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_invclean';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_invclean';
process.env.ADMIN_SECRET ||= 'test-admin-secret';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { encrypt } from '../api/_lib/secrets.js';
import invoiceIdHandler from '../api/invoices/[id].js';
import invoicesHandler from '../api/invoices/index.js';
import voidHandler from '../api/invoices/void.js';
import refundHandler from '../api/invoices/refund.js';
import archiveHandler from '../api/invoices/archive.js';
import markPaidHandler from '../api/invoices/mark-paid.js';
import financeHandler from '../api/finance/index.js';
import accountingExport from '../api/finance/accounting-export.js';
import taxExport from '../api/finance/tax-export.js';
import meInvoices from '../api/me/invoices/index.js';
import accessLink from '../api/me/invoices/[id]/access-link.js';
import invoiceView from '../api/invoice-view/[token].js';
import invoicePay from '../api/invoice-pay/[token].js';
import claimHandler from '../api/invoice-pay/claim.js';
import overdueCron from '../api/cron/invoice-overdue.js';
import dueSoonCron from '../api/cron/invoice-due-soon.js';
import legacyWebhook from '../api/webhooks/stripe/[workspaceId].js';
import { executeIvyTool, runApprovedTool, ledgerEntry, SENSITIVE_TOOLS } from '../api/_lib/ivyTools.js';
import { invoiceMoney, invoiceActions, invoiceStatusLine } from '../src/lib/invoiceRules.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const stripeCalls = [];
const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    stripeCalls.push({ url: u, body });
    if (/\/refunds$/.test(u)) return json({ id: `re_ic_${stripeCalls.length}`, amount: Number(body.amount || 0), status: 'succeeded' });
    return json({});
  }
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  return json({});
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const toList = (e) => (Array.isArray(e?.to) ? e.to : [e?.to]);
const mailsTo = (addr) => emails.filter((e) => toList(e).includes(addr));
const visible = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '');

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    send(s) { this.body = s; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
const HOST = 'www.joinivy.ai';
let ipN = 0;
const req = ({ method = 'GET', cookie, query = {}, body = {} } = {}) => ({
  method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin: `https://${HOST}`, host: HOST,
    'x-forwarded-for': `198.19.${Math.floor(++ipN / 250)}.${ipN % 250}`, ...(cookie ? { cookie } : {}) },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }
const sha = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const STAMP = Date.now();
const invRow = (id) => sql`SELECT * FROM invoices WHERE id = ${id}`.then((r) => r.rows[0]);
const cronReq = () => ({ method: 'GET', url: '/api/cron/x', query: {}, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });

async function mkBiz(label) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`invclean-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`${label} Studio`}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `invclean-${label}-${STAMP}`.toLowerCase();
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}, biz_name = ${`${label} Studio`}`;
  const acct = `acct_ic_${label}_${STAMP}`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status)
    VALUES (${wid}, ${acct}, 'complete')`;
  return { userId: u, wid, acct, cookie: `ivy_session=${signSession(u)}` };
}
let clientN = 0;
async function mkClient(biz, name = 'Casey Client') {
  const email = `invclean-client-${++clientN}-${STAMP}@example.com`;
  const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${biz.wid}, ${name}, ${email}, 'active') RETURNING id`).rows[0].id;
  return { cid, email, name };
}
let numN = 0;
// Make an invoice in a given state directly (the payment paths have their
// own suites). Returns { id, raw (view token), number, client }.
async function mkInv(biz, { status = 'sent', amount = 100, sent = true, paidAmount = null, paidMethod = null,
  refunded = 0, pi = null, processing = false, giftCents = 0, due = 14, client = null, archived = false } = {}) {
  const c = client || await mkClient(biz);
  const raw = crypto.randomBytes(24).toString('hex');
  const number = `IC-${++numN}-${STAMP % 100000}`;
  const id = (await sql`
    INSERT INTO invoices (workspace_id, client_id, client_name, client_email, number, status, items, tax_rate, discount,
      view_token_hash, sent_at, due_date, paid_amount, paid_method, paid_at, refunded_amount, refunded_at,
      stripe_payment_intent, payment_processing_at, gift_card_credit_cents, archived_at)
    VALUES (${biz.wid}, ${c.cid}, ${c.name}, ${c.email}, ${number}, ${status},
      ${JSON.stringify([{ id: 'li1', description: 'Session', quantity: 1, rate: amount }])}::jsonb, 0, 0,
      ${status === 'paid' || status === 'refunded' ? null : sha(raw)}, ${sent ? new Date() : null},
      CURRENT_DATE + ${due}::int, ${paidAmount}, ${paidMethod},
      ${status === 'paid' || status === 'refunded' ? new Date() : null}, ${refunded}, ${refunded > 0 ? new Date() : null},
      ${pi}, ${processing ? new Date() : null}, ${giftCents}, ${archived ? new Date() : null})
    RETURNING id`).rows[0].id;
  return { id, raw, number, client: c };
}

async function run() {
  await ensureSchemaApplied();
  const A = await mkBiz('a');
  const B = await mkBiz('b');
  const R = await mkBiz('r'); // revenue checks: only this suite's invoices live here
  // Legacy per-workspace Stripe secret on R so the old webhook path verifies.
  await sql`UPDATE finance_settings SET stripe_webhook_secret_encrypted = ${encrypt('whsec_legacy_ic')} WHERE workspace_id = ${R.wid}`;

  // ── [0] pure rules ──
  console.log('\n[0] the shared rule book');
  {
    const m = invoiceMoney({ status: 'refunded', total: 100, paidAmount: 100, refundedAmount: 100 });
    assert(m.net === 0 && m.owed === 0 && m.fullyRefunded, 'full refund: net $0, nothing owed');
    const line = invoiceStatusLine({ status: 'refunded', total: 100, paidAmount: 100, refundedAmount: 100, refundedAt: '2026-11-05T15:00:00Z' }, { timeZone: 'UTC' });
    assert(line === 'Refunded in full on Nov 5, 2026. Nothing owed.', `status line reads plainly (${line})`);
    const part = invoiceMoney({ status: 'sent', total: 100, paidAmount: 40, refundedAmount: 0, giftCardCreditCents: 1000 });
    assert(part.owed === 50 && part.net === 40, 'open invoice owes total minus gift card minus net paid');
    assert(!invoiceActions({ status: 'sent', total: 100, paidAmount: 40 }).void.ok, 'part-paid invoice cannot be voided');
    assert(invoiceActions({ status: 'draft', total: 10 }).delete.ok && !invoiceActions({ status: 'draft', total: 10, sentAt: '2026-01-01' }).delete.ok,
      'only a never-sent draft can be deleted');
    const dashFree = Object.values(invoiceActions({ status: 'paid', total: 5, paidAmount: 5 })).every((r) => !/[—–]/.test(r.why || ''));
    assert(dashFree, 'refusal copy has no em or en dashes');
  }

  // ── [1] matrix ──
  console.log('\n[1] each status x each action');
  const del = (biz, id) => call(invoiceIdHandler, req({ method: 'DELETE', cookie: biz.cookie, query: { id } }));
  const vd = (biz, id, extra = {}) => call(voidHandler, req({ method: 'POST', cookie: biz.cookie, body: { id, ...extra } }));
  const rf = (biz, id, amount) => call(refundHandler, req({ method: 'POST', cookie: biz.cookie, body: { id, amount } }));
  const ar = (biz, ids, archived = true) => call(archiveHandler, req({ method: 'POST', cookie: biz.cookie, body: { ids, archived } }));
  const getInv = (biz, id) => call(invoiceIdHandler, req({ cookie: biz.cookie, query: { id } }));

  const draft = await mkInv(A, { status: 'draft', sent: false });
  const draftSentBefore = await mkInv(A, { status: 'draft', sent: true });
  const sent = await mkInv(A, { status: 'sent' });
  const overdue = await mkInv(A, { status: 'overdue', due: -5 });
  const paid = await mkInv(A, { status: 'paid', paidAmount: 100, paidMethod: 'cash' });
  const refunded = await mkInv(A, { status: 'refunded', paidAmount: 100, paidMethod: 'cash', refunded: 100 });
  const voidedSent = await mkInv(A, { status: 'voided', sent: true });
  const voidedDraft = await mkInv(A, { status: 'voided', sent: false });
  const settling = await mkInv(A, { status: 'sent', processing: true });

  let r;
  // delete
  r = await del(A, sent.id);
  assert(r.statusCode === 400 && /already sent.*Void it instead/i.test(r.body.error), `delete sent: refused, says void (${r.body?.error})`);
  r = await del(A, overdue.id);
  assert(r.statusCode === 400 && /Void it instead/.test(r.body.error), 'delete overdue: refused');
  r = await del(A, paid.id);
  assert(r.statusCode === 400 && /can't be deleted because money moved.*archive/i.test(r.body.error), `delete paid: refused, says archive (${r.body?.error})`);
  r = await del(A, refunded.id);
  assert(r.statusCode === 400 && /money moved/.test(r.body.error), 'delete refunded: refused');
  r = await del(A, voidedSent.id);
  assert(r.statusCode === 400 && /sent before it was voided.*archive/i.test(r.body.error), 'delete voided (was sent): refused, says archive');
  r = await del(A, draftSentBefore.id);
  assert(r.statusCode === 400 && /sent before/i.test(r.body.error), 'delete a restored draft that was sent before: refused');
  assert(!!(await invRow(sent.id)) && !!(await invRow(paid.id)) && !!(await invRow(voidedSent.id)), 'refused deletes left every row in place');
  r = await del(A, voidedDraft.id);
  assert(r.statusCode === 204 && !(await invRow(voidedDraft.id)), 'delete a voided never-sent draft: allowed');

  // void
  r = await vd(A, paid.id);
  assert(r.statusCode === 400 && /paid invoice can't be voided.*Refund/i.test(r.body.error), `void paid: refused, says refund (${r.body?.error})`);
  r = await vd(A, refunded.id);
  assert(r.statusCode === 400 && /refunded in full.*nothing is owed/i.test(r.body.error), 'void refunded: refused, nothing owed');
  r = await vd(A, voidedSent.id);
  assert(r.statusCode === 400 && /already void/i.test(r.body.error), 'void voided: refused');
  r = await vd(A, settling.id);
  assert(r.statusCode === 400 && /bank payment/i.test(r.body.error), 'void while a bank payment is settling: refused');
  r = await vd(A, overdue.id);
  assert(r.statusCode === 200 && r.body.invoice.status === 'voided' && r.body.invoice.money.owed === 0, 'void overdue: allowed, owed $0');
  assert(/^Voided on .*Nothing owed\.$/.test(r.body.invoice.statusLine), `voided status line (${r.body.invoice.statusLine})`);

  // refund
  r = await rf(A, sent.id);
  assert(r.statusCode === 400 && /Nothing has been paid.*Void it instead/.test(r.body.error), 'refund unpaid: refused, says void');
  r = await rf(A, draft.id);
  assert(r.statusCode === 400 && /delete the draft/i.test(r.body.error), 'refund draft: refused, says delete');
  r = await rf(A, refunded.id);
  assert(r.statusCode === 400 && /already been fully refunded/.test(r.body.error), 'refund refunded: refused');
  r = await rf(A, voidedSent.id);
  assert(r.statusCode === 400 && /void and has no payment/.test(r.body.error), 'refund voided: refused');

  // archive
  r = await ar(A, [sent.id]);
  assert(r.statusCode === 200 && r.body.changed === 0 && /Open invoices are not archived/.test(r.body.skipped[0]?.why), 'archive open: skipped with reason');
  r = await ar(A, [draft.id]);
  assert(r.body.changed === 0 && /Delete the draft/.test(r.body.skipped[0]?.why), 'archive draft: skipped, says delete');
  r = await ar(A, [paid.id, refunded.id, voidedSent.id]);
  assert(r.statusCode === 200 && r.body.changed === 3, 'archive paid + refunded + voided: allowed');
  const p2 = await invRow(paid.id);
  assert(p2.status === 'paid' && Number(p2.paid_amount) === 100 && p2.archived_at, 'archiving changed nothing but archived_at');

  // mark paid
  r = await call(markPaidHandler, req({ method: 'POST', cookie: A.cookie, body: { id: refunded.id, method: 'cash' } }));
  assert(r.statusCode === 400 && /refunded in full/.test(r.body.error), 'mark paid on a refunded invoice: refused (no double income)');
  // edit locked
  r = await call(invoiceIdHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: refunded.id }, body: { notes: 'x' } }));
  assert(r.statusCode === 400, 'editing a refunded invoice: refused');

  // allowed map on the API response
  r = await getInv(A, sent.id);
  assert(r.body.invoice.allowed.void.ok && !r.body.invoice.allowed.delete.ok && !r.body.invoice.allowed.archive.ok,
    'GET returns allowed actions for the buttons');

  // delete draft
  r = await del(A, draft.id);
  assert(r.statusCode === 204 && !(await invRow(draft.id)), 'delete never-sent draft: allowed');

  // ── [2] void stops the pay link ──
  console.log('\n[2] void: pay link, client notice');
  const pv = await mkInv(A, { status: 'sent' });
  r = await call(invoiceView, req({ query: { token: pv.raw } }));
  assert(r.statusCode === 200 && !r.body.invoice.closed, 'before void: link opens as payable');
  const before = mailsTo(pv.client.email).length;
  r = await vd(A, pv.id, { notifyClient: true });
  await settle();
  assert(r.statusCode === 200 && r.body.clientNotified === true, 'void with notifyClient: client emailed');
  const vmail = mailsTo(pv.client.email).slice(before);
  assert(vmail.length === 1 && /was voided/.test(vmail[0].subject) && /don't owe anything/.test(visible(vmail[0].html)),
    'the email says it was voided and nothing is owed');
  assert(vmail.every((e) => !/[—–]/.test(visible(e.html)) && !/stripe|square|paypal/i.test(visible(e.html))), 'void email: no dashes, no vendor names');
  r = await call(invoiceView, req({ query: { token: pv.raw } }));
  assert(r.statusCode === 200 && r.body.invoice.closed === true && r.body.invoice.status === 'voided', 'after void: link shows the invoice as voided (read only)');
  assert(r.body.invoice.paymentEnabled === false && r.body.invoice.manualMethods.length === 0 && !r.body.invoice.allowed,
    'no pay options and no owner-only fields on the voided page');
  r = await call(invoicePay, req({ method: 'POST', query: { token: pv.raw } }));
  assert(r.statusCode === 404, 'paying a voided invoice: refused');
  r = await call(claimHandler, req({ method: 'POST', body: { token: pv.raw, method: 'venmo' } }));
  assert(r.statusCode === 404 || r.statusCode === 400, '"I\'ve paid" on a voided invoice: refused');
  const pvSilent = await mkInv(A, { status: 'sent' });
  const b2 = mailsTo(pvSilent.client.email).length;
  r = await vd(A, pvSilent.id);
  await settle();
  assert(r.statusCode === 200 && r.body.clientNotified === false && mailsTo(pvSilent.client.email).length === b2, 'void without the box: no email');

  // restore to draft after a void still works, and a restored draft that
  // was sent cannot be deleted
  r = await call(invoiceIdHandler, req({ method: 'PATCH', cookie: A.cookie, query: { id: pvSilent.id }, body: { status: 'draft' } }));
  assert(r.statusCode === 200 && r.body.invoice.status === 'draft' && !r.body.invoice.allowed.delete.ok, 'restore to draft works; still not deletable');

  // ── [3] delete releases billed time ──
  console.log('\n[3] delete a draft with billed time');
  const timeDraft = await mkInv(A, { status: 'draft', sent: false });
  const te = (await sql`INSERT INTO time_entries (workspace_id, description, started_at, ended_at, duration_seconds, hourly_rate, status, invoice_id)
    VALUES (${A.wid}, 'Design work', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', 3600, 50, 'billed', ${timeDraft.id}) RETURNING id`).rows[0].id;
  r = await del(A, timeDraft.id);
  const teRow = (await sql`SELECT status, invoice_id FROM time_entries WHERE id = ${te}`).rows[0];
  assert(r.statusCode === 204 && teRow.status === 'stopped' && teRow.invoice_id === null, 'the time goes back to ready to bill');

  // ── [4] part payment ──
  console.log('\n[4] part payment: refund it, then void');
  const part = await mkInv(A, { status: 'sent', paidAmount: 40, paidMethod: 'cash' });
  r = await vd(A, part.id);
  assert(r.statusCode === 400 && /\$40\.00 has been paid.*Refund that payment first/.test(r.body.error), `void refused while $40 is held (${r.body?.error})`);
  r = await getInv(A, part.id);
  assert(r.body.invoice.money.owed === 60 && r.body.invoice.allowed.refund.ok, 'owed $60; refund offered');
  r = await rf(A, part.id, 40);
  assert(r.statusCode === 200 && r.body.invoice.status === 'sent' && r.body.invoice.money.net === 0, 'refunding the part payment keeps it open, net $0');
  r = await vd(A, part.id);
  assert(r.statusCode === 200 && r.body.invoice.status === 'voided', 'then void works');

  // ── [5] paid -> refund -> archive, amounts everywhere ──
  console.log('\n[5] amounts after partial and full refund, everywhere');
  const rc = await mkClient(R, 'Robin Client');
  const card = await mkInv(R, { status: 'paid', amount: 200, paidAmount: 200, paidMethod: 'card', pi: `pi_ic_card_${STAMP}`, client: rc });
  const cash = await mkInv(R, { status: 'paid', amount: 100, paidAmount: 100, paidMethod: 'cash', client: rc });
  const summary = async () => (await call(financeHandler, req({ cookie: R.cookie }))).body.summary;
  const rev = async () => (await sql`SELECT * FROM workspace_revenue WHERE workspace_id = ${R.wid}`).rows[0];
  let s0 = await summary();
  assert(s0.totalPaid === 300 && s0.counts.paid === 2, 'Finance: $300 paid before refunds');
  assert(Number((await rev()).invoices) === 300, 'workspace_revenue: $300');

  const callsBefore = stripeCalls.length;
  r = await rf(R, card.id, 50);
  assert(r.statusCode === 200 && stripeCalls.length === callsBefore + 1 && stripeCalls.at(-1).body.amount === '5000', 'partial refund goes through the card processor ($50)');
  const m1 = r.body.invoice.money;
  assert(r.body.invoice.status === 'paid' && m1.paid === 200 && m1.refunded === 50 && m1.net === 150 && m1.owed === 0, 'API: paid 200, refunded 50, net 150, owed 0');
  assert(/^Paid \$200\.00 on .*\$50\.00 refunded on .*Net \$150\.00\. Nothing owed\.$/.test(r.body.invoice.statusLine), `status line after partial (${r.body.invoice.statusLine})`);
  s0 = await summary();
  assert(s0.totalPaid === 250, `Finance after partial refund: $250 (${s0.totalPaid})`);
  assert(Number((await rev()).invoices) === 250, 'workspace_revenue after partial refund: $250');

  // Client portal (signed in as the client).
  const cu = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${rc.email}, 'x', 'Robin', NOW()) RETURNING id`).rows[0].id;
  const clientCookie = `ivy_session=${signSession(cu)}`;
  r = await call(meInvoices, req({ cookie: clientCookie }));
  const pCard = r.body.invoices.find((i) => i.id === card.id);
  assert(pCard && pCard.amountDue === 0 && pCard.refundedAmount === 50 && pCard.netPaid === 150, 'client portal: $50 refunded, nothing due');

  r = await rf(R, card.id);
  assert(r.statusCode === 200 && r.body.invoice.status === 'refunded' && r.body.refund.amount === 150, 'full refund of the rest ($150)');
  const m2 = r.body.invoice.money;
  assert(m2.net === 0 && m2.owed === 0 && m2.refunded === 200, 'API after full refund: net $0, owed $0');
  assert(/^Refunded in full on .*\. Nothing owed\.$/.test(r.body.invoice.statusLine), `"Refunded in full on <date>. Nothing owed." (${r.body.invoice.statusLine})`);
  s0 = await summary();
  assert(s0.totalPaid === 100 && s0.counts.refunded === 1, 'Finance after full refund: $100, one refunded');
  assert(Number((await rev()).invoices) === 100, 'workspace_revenue after full refund: $100');

  r = await call(meInvoices, req({ cookie: clientCookie }));
  const pCard2 = r.body.invoices.find((i) => i.id === card.id);
  assert(pCard2.status === 'refunded' && pCard2.amountDue === 0, 'client portal: refunded, never owed');
  // Public page via the portal's View link.
  r = await call(accessLink, req({ method: 'POST', cookie: clientCookie, query: { id: card.id } }));
  const tok = decodeURIComponent(String(r.body.url).split('/invoice/')[1]);
  r = await call(invoiceView, req({ query: { token: tok } }));
  assert(r.statusCode === 200 && r.body.invoice.closed && r.body.invoice.status === 'refunded' && r.body.invoice.money.owed === 0,
    'public page for a refunded invoice: read only, nothing owed');
  assert(r.body.invoice.stripePaymentIntent === undefined, 'public page does not expose the payment id');

  // Exports.
  const year = new Date().getFullYear();
  r = await call(accountingExport, req({ cookie: R.cookie, query: { format: 'quickbooks', type: 'invoices', year: String(year) } }));
  const qbLines = String(r.body).split('\r\n').filter((l) => l.includes(card.number));
  assert(qbLines.some((l) => /Refund/.test(l) && l.includes('-200.00')), 'QuickBooks export: refund line of -200.00 nets the invoice to $0');
  r = await call(accountingExport, req({ cookie: R.cookie, query: { format: 'xero', type: 'invoices', year: String(year) } }));
  assert(String(r.body).split('\r\n').some((l) => l.includes(card.number) && l.includes('-200.00')), 'Xero export: refund line too');
  r = await call(taxExport, req({ cookie: R.cookie, query: { year: String(year) } }));
  const taxRow = String(r.body).split('\r\n').find((l) => l.includes(card.number)) || '';
  assert(/200\.00.*200\.00.*0\.00/.test(taxRow), `tax export: gross 200, refunded 200, net 0 (${taxRow})`);

  // Archive: hidden from the list, revenue unchanged, reversible.
  r = await ar(R, [card.id]);
  assert(r.body.changed === 1, 'archive the refunded invoice');
  s0 = await summary();
  assert(s0.totalPaid === 100 && s0.counts.refunded === 0 && s0.counts.archived === 1, 'archive: revenue unchanged; it leaves the Refunded count');
  assert(Number((await rev()).invoices) === 100, 'workspace_revenue unchanged by archive');
  r = await call(invoicesHandler, req({ cookie: R.cookie }));
  assert(!r.body.invoices.some((i) => i.id === card.id), 'default list (older apps too) hides archived');
  r = await call(invoicesHandler, req({ cookie: R.cookie, query: { archived: 'only' } }));
  assert(r.body.invoices.length === 1 && r.body.invoices[0].id === card.id && r.body.invoices[0].archivedAt, 'Archived filter shows it');
  r = await call(invoicesHandler, req({ cookie: R.cookie, query: { archived: 'all' } }));
  assert(r.body.invoices.length === 2, 'archived=all shows everything');
  r = await call(meInvoices, req({ cookie: clientCookie }));
  assert(r.body.invoices.some((i) => i.id === card.id && i.amountDue === 0), 'client still sees their refunded invoice as a receipt');
  r = await ar(R, [card.id], false);
  assert(r.body.changed === 1 && !(await invRow(card.id)).archived_at, 'unarchive puts it back');

  // ── [6] bulk ──
  console.log('\n[6] bulk archive with skips');
  const b1 = await mkInv(A, { status: 'paid', paidAmount: 10, paidMethod: 'cash' });
  const b2b = await mkInv(A, { status: 'voided' });
  const b3 = await mkInv(A, { status: 'sent' });
  r = await ar(A, [b1.id, b2b.id, b3.id, 'not-a-uuid']);
  assert(r.body.changed === 2 && r.body.skipped.length === 2, 'two archived, open one and junk id skipped');
  r = await ar(A, Array.from({ length: 201 }, () => crypto.randomUUID()));
  assert(r.statusCode === 400 && /up to 200/.test(r.body.error), 'more than 200 at once: refused');

  // ── [7] reminders ──
  console.log('\n[7] reminders never chase void, paid, archived, settling or covered invoices');
  const odOpen = await mkInv(A, { status: 'sent', due: -3, paidAmount: 40, paidMethod: 'cash' });
  const odVoid = await mkInv(A, { status: 'voided', due: -3 });
  const odPaid = await mkInv(A, { status: 'paid', due: -3, paidAmount: 100, paidMethod: 'cash' });
  const odSettling = await mkInv(A, { status: 'sent', due: -3, processing: true });
  const odCovered = await mkInv(A, { status: 'sent', due: -3, giftCents: 10000 });
  await call(overdueCron, cronReq());
  await settle(400);
  const odMail = mailsTo(odOpen.client.email);
  assert(odMail.length === 1 && /\$60\.00/.test(visible(odMail[0].html)), 'open overdue invoice: one reminder for what is owed ($60, not $100)');
  for (const [label, inv] of [['void', odVoid], ['paid', odPaid], ['settling', odSettling], ['fully covered', odCovered]]) {
    assert(mailsTo(inv.client.email).length === 0, `no overdue email for the ${label} invoice`);
  }
  assert((await invRow(odVoid.id)).status === 'voided', 'cron never flips a void invoice back to overdue');
  const dsOpen = await mkInv(A, { status: 'sent', due: 2 });
  const dsSettling = await mkInv(A, { status: 'sent', due: 2, processing: true });
  const dsVoid = await mkInv(A, { status: 'voided', due: 2 });
  await call(dueSoonCron, cronReq());
  await settle(400);
  assert(mailsTo(dsOpen.client.email).length === 1, 'due-soon: open invoice reminded');
  assert(mailsTo(dsSettling.client.email).length === 0 && mailsTo(dsVoid.client.email).length === 0, 'due-soon: settling and void ones are not');

  // ── [8] Ivy ──
  console.log('\n[8] Ivy: approval, truthful ledger, refusals');
  const ctx = { workspaceId: A.wid, userId: A.userId, sessionId: null };
  for (const t of ['void_invoice', 'delete_invoice', 'refund_invoice', 'archive_invoices']) {
    assert(SENSITIVE_TOOLS.has(t), `${t} is approval-gated`);
  }
  const iv = await mkInv(A, { status: 'sent' });
  let out = await executeIvyTool('void_invoice', { invoice_id: iv.id, notify_client: false, confirm: true }, ctx);
  assert(out.needs_confirmation && (await invRow(iv.id)).status === 'sent', 'void: waits for approval (confirm flag ignored), nothing changed');
  assert(/stays on record marked Void/.test(out.summary) && /not emailed/.test(out.summary), `approval card says what happens (${out.summary})`);
  out = await runApprovedTool('void_invoice', { invoice_id: iv.id }, ctx);
  assert(out.invoice?.status === 'voided', 'approved: voided');
  let led = ledgerEntry('void_invoice', { invoice_id: iv.id }, out);
  assert(led.ok && /nothing is owed/.test(led.summary), `ledger is truthful (${led.summary})`);

  const ivPaid = await mkInv(A, { status: 'paid', paidAmount: 80, paidMethod: 'cash' });
  out = await runApprovedTool('delete_invoice', { invoice_id: ivPaid.id }, ctx);
  assert(/money moved.*archive/i.test(out.error || ''), `delete paid via Ivy: refused in plain words (${out.error})`);
  led = ledgerEntry('delete_invoice', { invoice_id: ivPaid.id }, out);
  assert(led.status === 'failed' && !led.ok, 'ledger records it as not done');
  out = await runApprovedTool('void_invoice', { invoice_id: ivPaid.id }, ctx);
  assert(/Refund it instead/.test(out.error || ''), 'void paid via Ivy: refused, says refund');
  out = await executeIvyTool('refund_invoice', { invoice_id: ivPaid.id }, ctx);
  assert(out.needs_confirmation && /real money out/.test(out.summary), 'refund waits for approval');
  out = await runApprovedTool('refund_invoice', { invoice_id: ivPaid.id }, ctx);
  assert(out.ok && out.refund.fullyRefunded, 'approved refund ran');
  led = ledgerEntry('refund_invoice', { invoice_id: ivPaid.id }, out);
  assert(/Refunded \$80\.00 on invoice #.*Refunded in full on .*Nothing owed\./.test(led.summary), `ledger: amount and "Nothing owed" (${led.summary})`);
  out = await runApprovedTool('archive_invoices', { invoice_ids: [ivPaid.id] }, ctx);
  assert(out.changed === 1 && (await invRow(ivPaid.id)).archived_at, 'archive via Ivy');
  led = ledgerEntry('archive_invoices', { invoice_ids: [ivPaid.id] }, out);
  assert(/Archived 1 invoice .*revenue unchanged/.test(led.summary), `ledger: archived (${led.summary})`);
  out = await runApprovedTool('archive_invoices', { invoice_ids: [ivPaid.id], unarchive: true }, ctx);
  assert(out.changed === 1 && !(await invRow(ivPaid.id)).archived_at, 'unarchive via Ivy');
  const ivDraft = await mkInv(A, { status: 'draft', sent: false });
  out = await executeIvyTool('delete_invoice', { invoice_id: ivDraft.id }, ctx);
  assert(out.needs_confirmation && !!(await invRow(ivDraft.id)), 'delete draft waits for approval');
  out = await runApprovedTool('delete_invoice', { invoice_id: ivDraft.id }, ctx);
  assert(out.deleted && !(await invRow(ivDraft.id)), 'approved: draft deleted');
  out = await runApprovedTool('mark_invoice_paid', { invoice_id: ivPaid.id, method: 'cash' }, ctx);
  assert(/not unpaid/.test(out.error || "") && (await invRow(ivPaid.id)).status === "refunded", `Ivy cannot mark a refunded invoice paid again (${JSON.stringify(out).slice(0, 200)})`);
  const ivOpen = await mkInv(A, { status: 'sent', amount: 75 });
  out = await runApprovedTool('mark_invoice_paid', { invoice_id: ivOpen.id, method: 'cash' }, ctx);
  const ivOpenRow = await invRow(ivOpen.id);
  assert(out.ok && ivOpenRow.status === 'paid' && Number(ivOpenRow.paid_amount) === 75 && ivOpenRow.activity.some((a) => a.kind === 'paid'),
    'Ivy marking an unpaid invoice paid records what was collected and an activity line');
  const ivOpenLedger = (await sql`SELECT provider, amount FROM invoice_payments WHERE invoice_id = ${ivOpen.id} AND workspace_id = ${A.wid}`).rows;
  assert(ivOpenLedger.length === 1 && ivOpenLedger[0].provider === 'manual' && Number(ivOpenLedger[0].amount) === 75,
    `the $75 is on the payment ledger as money received by hand (${JSON.stringify(ivOpenLedger)})`);
  out = await executeIvyTool('search_invoices', { query: ivPaid.number }, ctx);
  const hit = out.invoices?.[0];
  assert(hit && hit.status === 'refunded' && hit.money.owed === 0 && hit.allowed.archive === true && /money moved/.test(hit.allowed.delete),
    'search shows money, status line and what is allowed (with reasons)');
  assert(/^Refunded in full on .*Nothing owed\.$/.test(hit.status_line), 'search status line');

  // ── [9] isolation ──
  console.log('\n[9] workspace isolation');
  const aOpen = await mkInv(A, { status: 'sent' });
  const aPaid = await mkInv(A, { status: 'paid', paidAmount: 50, paidMethod: 'cash' });
  const aDraft = await mkInv(A, { status: 'draft', sent: false });
  r = await vd(B, aOpen.id);
  assert(r.statusCode === 400 && /not found/i.test(r.body.error) && (await invRow(aOpen.id)).status === 'sent', "B cannot void A's invoice");
  r = await del(B, aDraft.id);
  assert(r.statusCode === 404 && !!(await invRow(aDraft.id)), "B cannot delete A's draft");
  r = await rf(B, aPaid.id);
  assert(r.statusCode === 400 && Number((await invRow(aPaid.id)).refunded_amount) === 0, "B cannot refund A's invoice");
  r = await ar(B, [aPaid.id]);
  assert(r.body.changed === 0 && !(await invRow(aPaid.id)).archived_at, "B cannot archive A's invoice");
  const bctx = { workspaceId: B.wid, userId: B.userId, sessionId: null };
  out = await runApprovedTool('void_invoice', { invoice_id: aOpen.id }, bctx);
  assert(/not found/i.test(out.error || '') && (await invRow(aOpen.id)).status === 'sent', "Ivy in B cannot void A's invoice");
  out = await runApprovedTool('archive_invoices', { invoice_ids: [aPaid.id] }, bctx);
  assert(!!out.error && !(await invRow(aPaid.id)).archived_at, "Ivy in B cannot archive A's invoice");
  r = await call(invoicesHandler, req({ cookie: B.cookie, query: { archived: 'all' } }));
  assert(!r.body.invoices.some((i) => i.id === aPaid.id), "B's list never includes A's invoices");

  // ── [10] legacy webhook refund sync ──
  console.log('\n[10] a Dashboard refund on the older Stripe webhook updates the invoice');
  const legacy = await mkInv(R, { status: 'paid', amount: 120, paidAmount: 120, paidMethod: 'card', pi: `pi_ic_legacy_${STAMP}`, client: rc });
  const payload = JSON.stringify({ id: `evt_ic_${STAMP}`, type: 'charge.refunded',
    data: { object: { id: `ch_ic_${STAMP}`, payment_intent: `pi_ic_legacy_${STAMP}`, amount: 12000, amount_refunded: 12000 } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_legacy_ic').update(`${ts}.${payload}`).digest('hex');
  const wres = mkRes();
  await legacyWebhook({ method: 'POST', url: `/api/webhooks/stripe/${R.wid}`, query: { workspaceId: R.wid }, body: payload,
    headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, wres);
  const lrow = await invRow(legacy.id);
  assert(wres.statusCode === 200 && lrow.status === 'refunded' && Number(lrow.refunded_amount) === 120, `invoice now Refunded, $120 back (${wres.statusCode} ${JSON.stringify(wres.body)})`);

  console.log(`\n${pass} passed, ${fail} failed`);
}

run()
  .catch((e) => { console.error(e); fail++; })
  .finally(async () => {
    try {
      const ws = await sql`SELECT w.id FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE u.email LIKE ${`invclean-%-${STAMP}@example.com`}`;
      for (const { id } of ws.rows) {
        await sql`DELETE FROM time_entries WHERE workspace_id = ${id}`;
        await sql`DELETE FROM invoices WHERE workspace_id = ${id}`;
      }
    } catch { /* best effort */ }
    process.exit(fail ? 1 : 0);
  });
