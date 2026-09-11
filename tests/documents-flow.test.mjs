// Documents, end to end, at the API level - the flow a DocuSign user
// expects to just work:
//   1. Template → send → signer opens link → signs → document completes,
//      and BOTH the owner and the signer get a completion email carrying
//      the executed PDF (written documents included - they used to leave
//      everyone with nothing to download).
//   2. Two-party agreement where the owner countersigns: {self:true}
//      recipient, sequential hand-off, owner signs via /documents/self-sign,
//      one completion email per person (no duplicate for the owner).
//   3. Owner first in line gets selfSignUrl straight back from send.
//   4. The written-document renderer produces a real multi-page PDF.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/documents-flow.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { renderWrittenPdf } from '../api/_lib/pdfStamp.js';
import { PDFDocument } from 'pdf-lib';
import templatesHandler from '../api/documents/templates.js';
import sendHandler from '../api/documents/send.js';
import selfSignHandler from '../api/documents/self-sign.js';
import signHandler from '../api/sign/[token].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Capture every email the handlers try to send (Resend is the only
// outbound call these paths make besides Blob, which has no token here
// and fails soft - the PDF still rides along as an attachment).
const outbox = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('api.resend.com')) {
    const body = JSON.parse(init.body || '{}');
    outbox.push({ to: [].concat(body.to).join(','), subject: body.subject, html: body.html || '', attachments: body.attachments || [] });
    return { ok: true, status: 200, json: async () => ({ id: 'em_test' }), text: async () => '{}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};
const linkIn = (html) => (html.match(/\/sign\/([^"'\s<?]+)/) || [])[1];
const mailsFor = (email, re) => outbox.filter((m) => m.to.includes(email) && re.test(m.subject));
const isPdf = (att) => att && Buffer.from(att.content, 'base64').subarray(0, 5).toString() === '%PDF-';

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body = {}, query = {}, cookie } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'user-agent': 'test-agent', 'x-forwarded-for': `198.18.1.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}) } };
}

const STAMP = Date.now();
const OWNER_EMAIL = `docs-owner-${STAMP}@example.com`;
const MIA_EMAIL = `docs-mia-${STAMP}@example.com`;
let userId, wsId, cookie, miaId;

async function setup() {
  await ensureSchemaApplied();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${OWNER_EMAIL}, 'x', 'Coach Kay', NOW()) RETURNING id`;
  userId = u.rows[0].id;
  cookie = `ivy_session=${signSession(userId)}`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${userId}, 'Docs WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  wsId = w.rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone)
    VALUES (${wsId}, 'Kay Coaching', ${`docs-${STAMP}`}, 'America/Los_Angeles')
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${`docs-${STAMP}`}`;
  miaId = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${wsId}, 'Member Mia', ${MIA_EMAIL}, 'active') RETURNING id`).rows[0].id;
}

async function createFromTemplate(templateId) {
  const r = mockRes();
  await templatesHandler(req({ method: 'POST', cookie, body: { templateId } }), r);
  assert(r.statusCode === 201 || r.statusCode === 200, `template "${templateId}" cloned (got ${r.statusCode}: ${JSON.stringify(r.body).slice(0, 120)})`);
  return r.body.document;
}
async function send(id, recipients) {
  const r = mockRes();
  await sendHandler(req({ method: 'POST', cookie, body: { id, recipients } }), r);
  assert(r.statusCode === 200, `send ok (got ${r.statusCode}: ${JSON.stringify(r.body).slice(0, 160)})`);
  return r.body;
}
async function openLink(token) {
  const r = mockRes();
  await signHandler(req({ method: 'GET', query: { token } }), r);
  return r;
}
async function sign(token, doc, signerIndex) {
  const mine = (doc.fields || []).filter((f) => (f.signerIndex || 0) === signerIndex);
  const fields = mine.map((f) => ({ id: f.id, type: f.type, value: f.type === 'signature' ? 'Typed Name' : f.type === 'date' ? '2026-09-11' : 'ok' }));
  const r = mockRes();
  await signHandler(req({ method: 'POST', query: { token }, body: { fields } }), r);
  return r;
}

async function run() {
  await setup();

  // ── 1. Single signer, written template ──────────────────────────
  console.log('\n[1] waiver: send → open → sign → completion emails with the signed PDF');
  const waiver = await createFromTemplate('fitness-liability-waiver');
  const sent = await send(waiver.id, [{ clientId: miaId }]);
  assert(sent.document?.status === 'sent', 'document is "sent"');
  assert(sent.document?.signers?.length === 1 && sent.document.signers[0].isOwner === false, 'one signer row, not the owner');
  const inviteMail = mailsFor(MIA_EMAIL, /Action needed/)[0];
  assert(!!inviteMail, 'signer got the "Action needed" email');
  const token1 = inviteMail && linkIn(inviteMail.html);
  assert(!!token1, 'email carries a /sign/ link');

  let r = await openLink(token1);
  assert(r.statusCode === 200 && r.body?.document?.name === waiver.name, `link opens the document (got ${r.statusCode})`);
  assert(r.body?.signer?.position === 1 && r.body?.signer?.total === 1, 'signer position 1 of 1');

  r = await sign(token1, r.body.document, 0);
  assert(r.statusCode === 200 && r.body?.completed === true, `sign completes the document (got ${r.statusCode}: ${JSON.stringify(r.body).slice(0, 120)})`);
  const row = (await sql`SELECT status, completion_hash FROM documents WHERE id = ${waiver.id}`).rows[0];
  assert(row.status === 'completed' && /^[0-9a-f]{64}$/.test(row.completion_hash || ''), 'status completed + SHA-256 completion hash stored');

  const ownerDone = mailsFor(OWNER_EMAIL, /^Signed:/);
  assert(ownerDone.length === 1, `owner got exactly one completion email (got ${ownerDone.length})`);
  assert(isPdf(ownerDone[0]?.attachments?.[0]), 'owner email carries the signed PDF attachment');
  assert(/signed-\.pdf$|-signed\.pdf$/.test(ownerDone[0]?.attachments?.[0]?.filename || ''), `attachment is named *-signed.pdf (${ownerDone[0]?.attachments?.[0]?.filename})`);
  const miaDone = mailsFor(MIA_EMAIL, /^Signed:/);
  assert(miaDone.length === 1 && isPdf(miaDone[0].attachments?.[0]), 'signer got one completion email with the signed PDF');

  r = await openLink(token1);
  assert(r.statusCode === 404, 'used link is dead afterwards');

  // ── 2. Two-party agreement, owner countersigns ──────────────────
  console.log('\n[2] NDA: client signs first, owner countersigns via self-sign, one email each');
  const nda = await createFromTemplate('nda-mutual');
  const sent2 = await send(nda.id, [{ clientId: miaId }, { self: true }]);
  assert(sent2.selfSignUrl === undefined, 'no selfSignUrl when the owner is not first');
  const rows2 = sent2.document.signers;
  assert(rows2.length === 2 && rows2[1].isOwner === true && rows2[1].email === OWNER_EMAIL, 'owner is signer 2, flagged isOwner, at the account email');
  assert(mailsFor(OWNER_EMAIL, /Action needed.*Mutual/).length === 0, 'owner is NOT emailed before their turn');

  const mia2 = mailsFor(MIA_EMAIL, /Action needed.*Mutual/)[0];
  const tokenMia = mia2 && linkIn(mia2.html);
  r = await openLink(tokenMia);
  assert(r.statusCode === 200, 'Mia opens the NDA');
  r = await sign(tokenMia, r.body.document, 0);
  assert(r.statusCode === 200 && r.body?.nextSigner?.name, `Mia signs; handed to next (${r.body?.nextSigner?.name})`);
  assert(mailsFor(OWNER_EMAIL, /Action needed.*Mutual/).length === 1, 'owner emailed now that it is their turn');

  // Owner signs from the editor: self-sign mints a link on their own row.
  let sr = mockRes();
  await selfSignHandler(req({ method: 'POST', cookie, body: { id: nda.id } }), sr);
  assert(sr.statusCode === 200 && /\/sign\//.test(sr.body?.url || ''), `self-sign link minted (got ${sr.statusCode}: ${JSON.stringify(sr.body).slice(0, 100)})`);
  assert(/back=documents/.test(sr.body?.url || ''), 'self-sign link carries back=documents');
  const tokenOwner = linkIn(sr.body.url);
  r = await openLink(tokenOwner);
  assert(r.statusCode === 200 && r.body?.signer?.position === 2, 'owner opens as signer 2 of 2');
  const party1 = (r.body.document.fields || []).find((f) => (f.signerIndex || 0) === 0 && f.type === 'signature');
  assert(party1?.value === 'Typed Name', "owner's view already contains Mia's signature value");
  r = await sign(tokenOwner, r.body.document, 1);
  assert(r.statusCode === 200 && r.body?.completed === true, 'owner signs; NDA completes');
  assert(mailsFor(OWNER_EMAIL, /^Signed:.*Mutual/).length === 1, 'owner gets ONE NDA completion email (no duplicate for being a signer)');
  assert(mailsFor(MIA_EMAIL, /^Signed:.*Mutual/).length === 1, 'Mia gets one NDA completion email');
  assert(isPdf(mailsFor(OWNER_EMAIL, /^Signed:.*Mutual/)[0].attachments?.[0]), 'NDA completion carries the signed PDF');

  sr = mockRes();
  await selfSignHandler(req({ method: 'POST', cookie, body: { id: nda.id } }), sr);
  assert(sr.statusCode === 400, 'self-sign refused once the document is complete');

  // ── 3. Owner first in line ──────────────────────────────────────
  console.log('\n[3] coaching agreement: owner signs first, send returns selfSignUrl');
  const coaching = await createFromTemplate('coaching-agreement');
  const sent3 = await send(coaching.id, [{ self: true }, { clientId: miaId }]);
  assert(/\/sign\//.test(sent3.selfSignUrl || ''), 'send returns selfSignUrl for the owner');
  assert(sent3.document.signers[0].isOwner && sent3.document.signers[0].status === 'awaiting', 'owner row is awaiting');
  // Adding the owner twice on one document must be rejected.
  const dupRes = mockRes();
  await sendHandler(req({ method: 'POST', cookie, body: { id: coaching.id, recipients: [{ self: true }, { self: true }] } }), dupRes);
  assert(dupRes.statusCode === 400, `owner twice on one document is rejected (got ${dupRes.statusCode})`);

  // ── 4. Renderer ─────────────────────────────────────────────────
  console.log('\n[4] written-document PDF renderer');
  const bytes = await renderWrittenPdf({
    doc: { id: 'x', name: 'Render Test', content_html: '<h1>Title</h1><p>Para one.</p><ul><li>bullet</li></ul>', completed_at: new Date(), activity: [] },
    fields: [{ id: 'a', type: 'signature', label: 'Signature', signerIndex: 0 }, { id: 'b', type: 'date', label: 'Date', signerIndex: 0 }],
    signers: [{ order_index: 0, name: 'Member Mia', email: MIA_EMAIL, signed_at: new Date(), ip: '1.1.1.1', user_agent: 'ua', field_values: [{ id: 'a', value: 'Member Mia' }, { id: 'b', value: '2026-09-11' }] }],
    hash: 'ab'.repeat(32), business: 'Kay Coaching',
  });
  const pdf = await PDFDocument.load(bytes);
  assert(Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-', 'renders a PDF');
  assert(pdf.getPageCount() >= 2, `body page + signing record (${pdf.getPageCount()} pages)`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('documents-flow test crashed:', e); process.exit(1); });
