// Manual payment methods (Zelle / Venmo / Cash App / cash / check):
//   • owner settings validation on /api/finance/manual-methods
//   • public invoice view lists enabled methods only, nothing when paid
//   • "I've sent it" claim stamps the invoice + notifies the owner once
//   • a re-claim inside 24h updates the method but sends nothing new
//   • confirm (mark-paid) records paid_method='zelle' and leaves the rest
//   • clear-claim resets the claim and can message the client
//   • workspace isolation across owners
//   • receipt copy reads "Zelle" / "Venmo" / "Cash App"
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/manual-payments.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { serializeInvoicePublic, paidMethodLabel, VALID_PAID_METHOD } from '../api/_lib/finance.js';
import manualMethodsHandler from '../api/finance/manual-methods.js';
import viewHandler from '../api/invoice-view/[token].js';
import claimHandler from '../api/invoice-pay/claim.js';
import markPaidHandler from '../api/invoices/mark-paid.js';
import clearClaimHandler from '../api/invoices/clear-claim.js';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

// Capture every email the handlers try to send.
const outbox = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('api.resend.com')) {
    const body = JSON.parse(init.body || '{}');
    outbox.push({ to: [].concat(body.to).join(','), subject: body.subject, html: body.html || '' });
    return { ok: true, status: 200, json: async () => ({ id: 'em_test' }), text: async () => '{}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};
const mailsTo = (email) => outbox.filter((m) => m.to.includes(email));

function mockRes() {
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

const ownerReq = (cookie, { method = 'POST', body = {}, query = {} } = {}) => ({
  method, url: '/test', query, body,
  headers: {
    'content-type': 'application/json', cookie,
    origin: 'http://localhost:3000', host: 'localhost:3000',
    'x-forwarded-for': '203.0.113.50',
  },
});
let ipCounter = 100;
const publicReq = ({ method = 'POST', body = {}, query = {}, ip } = {}) => ({
  method, url: '/test', query, body,
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip || `198.51.100.${ipCounter++}` },
});

async function mkOwner(tag) {
  const email = `${tag}@example.com`;
  const uid = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', 'Owner Person', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${wid}, 'USD') ON CONFLICT (workspace_id) DO NOTHING`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`Biz ${tag}`}, ${`biz-${tag}`}) ON CONFLICT DO NOTHING`;
  const cid = (await sql`INSERT INTO clients (workspace_id, name, email) VALUES (${wid}, 'Casey Client', ${`casey-${tag}@example.com`}) RETURNING id`).rows[0].id;
  return { uid, wid, cid, email, cookie: `ivy_session=${signSession(uid)}` };
}

async function mkInvoice({ wid, cid, token, status = 'sent', rate = 150 }) {
  return (await sql.query(
    `INSERT INTO invoices (workspace_id, number, client_id, client_name, client_email, issue_date, due_date, items, status, view_token_hash)
     VALUES ($1,$2,$3,'Casey Client',$4,CURRENT_DATE,CURRENT_DATE,$5::jsonb,$6,$7) RETURNING id, number`,
    [wid, `INV-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, cid, `casey-${wid.slice(0, 8)}@example.com`,
     JSON.stringify([{ id: 'l', description: 'Session', quantity: 1, rate }]), status, token ? hash(token) : null],
  )).rows[0];
}

async function run() {
  await ensureSchemaApplied();
  const tag = `mp-${Date.now()}`;
  const A = await mkOwner(`${tag}-a`);
  const B = await mkOwner(`${tag}-b`);

  console.log('\n[1] settings validation');
  let res = mockRes();
  await manualMethodsHandler(ownerReq(A.cookie, { method: 'PATCH', body: { methods: [{ type: 'bitcoin', handle: 'x', enabled: true }] } }), res);
  assert(res.statusCode === 400, 'unknown type → 400');

  res = mockRes();
  await manualMethodsHandler(ownerReq(A.cookie, { method: 'PATCH', body: { methods: Array.from({ length: 7 }, () => ({ type: 'other', handle: 'x', enabled: false })) } }), res);
  assert(res.statusCode === 400, 'seven entries → 400');

  res = mockRes();
  await manualMethodsHandler(ownerReq(A.cookie, { method: 'PATCH', body: { methods: [{ type: 'zelle', handle: 'x'.repeat(121), enabled: true }] } }), res);
  assert(res.statusCode === 400, 'handle over 120 chars → 400');

  res = mockRes();
  await manualMethodsHandler(ownerReq(A.cookie, { method: 'PATCH', body: { methods: [{ type: 'zelle', handle: '', enabled: true }] } }), res);
  assert(res.statusCode === 400, 'Zelle on with no handle → 400');

  res = mockRes();
  await manualMethodsHandler(ownerReq(A.cookie, { method: 'PATCH', body: { methods: [
    { type: 'zelle', handle: '  555-0100  ', note: '  ', enabled: true },
    { type: 'venmo', handle: '@owner-a', enabled: true },
    { type: 'cashapp', handle: '$ownera', enabled: false },
    { type: 'cash', enabled: true, note: 'At your appointment' },
  ] } }), res);
  assert(res.statusCode === 200, 'valid list saves');
  const zelle = res.body?.methods?.find((m) => m.type === 'zelle');
  assert(zelle?.handle === '555-0100' && zelle.note === '', 'handle + note trimmed');

  res = mockRes();
  await manualMethodsHandler(ownerReq(A.cookie, { method: 'GET' }), res);
  assert(res.body?.methods?.length === 4, 'GET returns the saved list');
  res = mockRes();
  await manualMethodsHandler(ownerReq(B.cookie, { method: 'GET' }), res);
  assert(Array.isArray(res.body?.methods) && res.body.methods.length === 0, 'workspace B sees none of A\'s methods');

  console.log('\n[2] public view lists enabled methods only, nothing when paid');
  const tokA = `tok-${tag}-a-abcdefghij`;
  const invA = await mkInvoice({ wid: A.wid, cid: A.cid, token: tokA });
  res = mockRes();
  await viewHandler(publicReq({ method: 'GET', query: { token: tokA } }), res);
  const pub = res.body?.invoice;
  assert(res.statusCode === 200 && Array.isArray(pub?.manualMethods), 'public payload carries manualMethods');
  const types = (pub?.manualMethods || []).map((m) => m.type).sort();
  assert(types.join(',') === 'cash,venmo,zelle', `only enabled methods (got ${types.join(',')})`);
  assert(pub?.manualMethods.find((m) => m.type === 'zelle')?.handle === '555-0100', 'handle is exposed to the client');
  assert(pub?.paymentClaimedAt == null && !('paymentClaimedNote' in (pub || {})), 'no claim yet; note never exposed');

  const paidRow = { ...(await sql`SELECT * FROM invoices WHERE id = ${invA.id}`).rows[0], status: 'paid' };
  const pubPaid = serializeInvoicePublic(paidRow, { manualMethods: pub.manualMethods });
  assert(pubPaid.manualMethods.length === 0, 'paid invoice serializes with no manual methods');
  const tokPaid = `tok-${tag}-paid-abcdefgh`;
  await mkInvoice({ wid: A.wid, cid: A.cid, token: tokPaid, status: 'paid' });
  res = mockRes();
  await viewHandler(publicReq({ method: 'GET', query: { token: tokPaid } }), res);
  assert(res.statusCode === 404, 'paid invoice is not served publicly at all');

  console.log('\n[3] claim stamps the invoice and notifies the owner once');
  outbox.length = 0;
  res = mockRes();
  await claimHandler(publicReq({ body: { token: tokA, method: 'zelle', note: 'sent from my bank app' } }), res);
  assert(res.statusCode === 200 && res.body?.ok === true && res.body.method === 'zelle', 'claim → 200 with method');
  assert(res.body?.business === `Biz ${tag}-a`, 'response names the business for the thank-you copy');
  let row = (await sql`SELECT * FROM invoices WHERE id = ${invA.id}`).rows[0];
  assert(row.payment_claimed_at && row.payment_claimed_method === 'zelle' && row.payment_claimed_note === 'sent from my bank app', 'payment_claimed_* set');
  assert(row.status === 'sent' && row.paid_at == null, 'invoice is NOT marked paid by a claim');
  assert(row.payment_claim_notified_at != null, 'notified_at stamped');
  assert((row.activity || []).some((a) => a.kind === 'client-marked-paid' && /Zelle/.test(a.text)), 'activity entry mentions Zelle');
  const ownerMails = mailsTo(A.email);
  assert(ownerMails.length === 1, `owner got exactly one email (got ${ownerMails.length})`);
  assert(/says they paid .* by Zelle/.test(ownerMails[0]?.subject || ''), `subject: ${ownerMails[0]?.subject}`);
  assert(ownerMails[0]?.html.includes(`/finance?invoice=${invA.id}`), 'email deep-links to the invoice in Finance');
  assert(ownerMails[0]?.html.includes('$150.00') && ownerMails[0].html.includes(invA.number), 'email names the amount + number');
  const feed = await sql`SELECT * FROM notifications WHERE user_id = ${A.uid} AND tag = ${`invoice-claim-${invA.id}`}`;
  assert(feed.rows.length === 1 && feed.rows[0].url === `/finance?invoice=${invA.id}`, 'owner feed row with the Finance deep link');
  assert(/Casey Client says they paid invoice .* \(\$150\.00\) by Zelle\. Confirm it in Finance\./.test(feed.rows[0]?.body || ''), `push body: ${feed.rows[0]?.body}`);
  const sys = await sql`
    SELECT m.* FROM messages m JOIN message_threads t ON t.id = m.thread_id
    WHERE t.workspace_id = ${A.wid} AND t.client_id = ${A.cid} AND m.kind = 'invoice-claimed'`;
  assert(sys.rows.length === 1 && sys.rows[0].sender === 'system' && /Zelle/.test(sys.rows[0].text), 'system message in the client thread');

  // The public view now reports the claim so a reload shows "Thanks".
  res = mockRes();
  await viewHandler(publicReq({ method: 'GET', query: { token: tokA } }), res);
  assert(res.body?.invoice?.paymentClaimedAt && res.body.invoice.paymentClaimedMethod === 'zelle', 'public view reflects the claim');

  console.log('\n[4] re-claim within 24h: method updates, no second notification');
  res = mockRes();
  await claimHandler(publicReq({ body: { token: tokA, method: 'venmo' } }), res);
  assert(res.statusCode === 200, 'second claim → 200');
  row = (await sql`SELECT * FROM invoices WHERE id = ${invA.id}`).rows[0];
  assert(row.payment_claimed_method === 'venmo', 'method updated to venmo');
  assert(mailsTo(A.email).length === 1, 'still exactly one owner email');
  const feed2 = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${A.uid} AND tag LIKE 'invoice-claim-%'`;
  assert(feed2.rows[0].n === 1, 'still one feed row');
  const sys2 = await sql`
    SELECT count(*)::int AS n FROM messages m JOIN message_threads t ON t.id = m.thread_id
    WHERE t.workspace_id = ${A.wid} AND m.kind = 'invoice-claimed'`;
  assert(sys2.rows[0].n === 1, 'still one system message');

  // Age the stamp past the window: the next claim notifies again.
  await sql`UPDATE invoices SET payment_claim_notified_at = NOW() - INTERVAL '25 hours' WHERE id = ${invA.id}`;
  res = mockRes();
  await claimHandler(publicReq({ body: { token: tokA, method: 'zelle' } }), res);
  assert(mailsTo(A.email).length === 2, 'a claim after 24h notifies the owner again');

  res = mockRes();
  await claimHandler(publicReq({ body: { token: tokA, method: 'bitcoin' } }), res);
  assert(res.statusCode === 400, 'unknown claim method → 400');
  res = mockRes();
  await claimHandler(publicReq({ body: { token: `tok-${tag}-nope-abcdefghij`, method: 'zelle' } }), res);
  assert(res.statusCode === 404, 'unknown token → 404');

  console.log('\n[5] owner confirms: mark-paid with the claimed method');
  outbox.length = 0;
  res = mockRes();
  await markPaidHandler(ownerReq(A.cookie, { body: { id: invA.id, method: 'zelle' } }), res);
  assert(res.statusCode === 200 && res.body?.invoice?.status === 'paid', 'mark-paid → paid');
  assert(res.body?.invoice?.paidMethod === 'zelle', 'paid_method = zelle');
  row = (await sql`SELECT * FROM invoices WHERE id = ${invA.id}`).rows[0];
  assert(Number(row.paid_amount) === 150 && row.paid_at != null && row.view_token_hash == null, 'paid_amount, paid_at, token consumed');
  assert(row.payment_claimed_at != null && row.payment_claimed_method === 'zelle', 'claim history left in place (nothing else cleared)');
  assert((row.activity || []).some((a) => a.kind === 'paid' && a.text.startsWith('Paid by Zelle')), 'activity reads "Paid by Zelle"');
  // Receipt to the client is fire-and-forget; give it a beat.
  await new Promise((r) => setTimeout(r, 300));
  const receipt = mailsTo(`casey-${A.wid.slice(0, 8)}@example.com`).find((m) => /^Receipt:/.test(m.subject));
  assert(!!receipt, 'client got the receipt email');
  assert(receipt?.html.includes('paid by Zelle') && !receipt.html.includes('paid by zelle'), 'receipt label reads "Zelle"');

  console.log('\n[6] clear-claim resets the claim and can message the client');
  const tokA2 = `tok-${tag}-a2-abcdefghij`;
  const invA2 = await mkInvoice({ wid: A.wid, cid: A.cid, token: tokA2 });
  res = mockRes();
  await claimHandler(publicReq({ body: { token: tokA2, method: 'cashapp' } }), res);
  row = (await sql`SELECT payment_claimed_method FROM invoices WHERE id = ${invA2.id}`).rows[0];
  assert(row.payment_claimed_method === 'cashapp', 'second invoice claimed by cashapp');
  res = mockRes();
  await clearClaimHandler(ownerReq(A.cookie, { body: { id: invA2.id, message: "I don't see it yet, could you double-check?" } }), res);
  assert(res.statusCode === 200 && res.body?.invoice?.paymentClaimedAt == null, 'clear-claim → claim gone in response');
  row = (await sql`SELECT * FROM invoices WHERE id = ${invA2.id}`).rows[0];
  assert(row.payment_claimed_at == null && row.payment_claimed_method == null && row.payment_claimed_note == null && row.payment_claim_notified_at == null, 'all claim columns reset');
  assert(row.status === 'sent', 'invoice still sent (not voided, not paid)');
  assert((row.activity || []).some((a) => a.kind === 'not-received' && /Cash App/.test(a.text)), 'activity records not received with the label');
  const bizMsg = await sql`
    SELECT m.* FROM messages m JOIN message_threads t ON t.id = m.thread_id
    WHERE t.workspace_id = ${A.wid} AND t.client_id = ${A.cid} AND m.kind = 'invoice-not-received'`;
  assert(bizMsg.rows.length === 1 && bizMsg.rows[0].sender === 'biz' && /double-check/.test(bizMsg.rows[0].text), 'optional message lands in the thread from the business');
  res = mockRes();
  await clearClaimHandler(ownerReq(A.cookie, { body: { id: invA2.id } }), res);
  assert(res.statusCode === 200 && res.body?.noop === true, 'clearing again is a no-op');
  // After a clear, a fresh claim notifies the owner again (the stamp was reset).
  const before = mailsTo(A.email).length;
  res = mockRes();
  await claimHandler(publicReq({ body: { token: tokA2, method: 'cashapp' } }), res);
  assert(mailsTo(A.email).length === before + 1, 'claim after clear notifies again');

  console.log('\n[7] workspace isolation');
  const tokB = `tok-${tag}-b-abcdefghij`;
  const invB = await mkInvoice({ wid: B.wid, cid: B.cid, token: tokB });
  res = mockRes();
  await claimHandler(publicReq({ body: { token: tokB, method: 'venmo' } }), res);
  assert(res.statusCode === 200, 'B\'s token claims B\'s invoice');
  const a2 = (await sql`SELECT payment_claimed_method FROM invoices WHERE id = ${invA2.id}`).rows[0];
  const b1 = (await sql`SELECT payment_claimed_method, workspace_id FROM invoices WHERE id = ${invB.id}`).rows[0];
  assert(a2.payment_claimed_method === 'cashapp' && b1.payment_claimed_method === 'venmo' && b1.workspace_id === B.wid, 'claim touched only its own workspace\'s row');
  assert(mailsTo(B.email).length === 1 && mailsTo(A.email).length === before + 1, 'only owner B was notified for B\'s invoice');
  res = mockRes();
  await clearClaimHandler(ownerReq(A.cookie, { body: { id: invB.id } }), res);
  assert(res.statusCode === 400, 'owner A cannot clear a claim on B\'s invoice');
  res = mockRes();
  await markPaidHandler(ownerReq(A.cookie, { body: { id: invB.id, method: 'venmo' } }), res);
  assert(res.statusCode === 400, 'owner A cannot confirm B\'s invoice');
  const bStill = (await sql`SELECT status, payment_claimed_method FROM invoices WHERE id = ${invB.id}`).rows[0];
  assert(bStill.status === 'sent' && bStill.payment_claimed_method === 'venmo', 'B\'s invoice untouched by A');
  res = mockRes();
  await claimHandler(publicReq({ method: 'GET' }), res);
  assert(res.statusCode === 405, 'claim is POST-only');

  console.log('\n[8] public rate limit');
  const ip = '198.51.100.250';
  let blocked = false;
  for (let i = 0; i < 11; i++) {
    res = mockRes();
    await claimHandler(publicReq({ body: { token: tokB, method: 'venmo' }, ip }), res);
    if (res.statusCode === 429) { blocked = true; break; }
  }
  assert(blocked, '11th claim from one IP inside an hour → 429');

  console.log('\n[9] labels');
  assert(VALID_PAID_METHOD.has('zelle') && VALID_PAID_METHOD.has('venmo') && VALID_PAID_METHOD.has('cashapp'), 'VALID_PAID_METHOD accepts the new methods');
  assert(paidMethodLabel('zelle') === 'Zelle' && paidMethodLabel('venmo') === 'Venmo' && paidMethodLabel('cashapp') === 'Cash App', 'labels read Zelle / Venmo / Cash App');
  assert(paidMethodLabel('card') === 'card' && paidMethodLabel(undefined) === 'other', 'legacy labels unchanged');

  // Cleanup.
  for (const o of [A, B]) {
    await sql`DELETE FROM workspaces WHERE id = ${o.wid}`;
    await sql`DELETE FROM users WHERE id = ${o.uid}`;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
