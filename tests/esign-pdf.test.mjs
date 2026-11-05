// E-sign with an uploaded PDF, end to end at the API level (the DocuSign
// flow Kayla asked for):
//   1. Upload validation: the PATCH that points a document at an uploaded
//      file re-reads it server side: wrong workspace prefix, not a PDF,
//      broken PDF, locked PDF are refused; a good one gets its real page
//      count and SHA-256 from the server.
//   2. Field placement storage: every field type, positions kept as page
//      fractions, fields on pages the PDF doesn't have are refused,
//      dropdown options cleaned, duplicate ids fixed.
//   3. Send checks (fields for a signer who isn't on the list, a signer
//      with nothing to sign, dropdown without choices).
//   4. Signing: consent required, required fields, a signer can't fill
//      someone else's field, Date signed / Email decided by the server,
//      drawn signature + initials reused across fields, dropdown and
//      checkbox rules, owner notified on open, owner countersigns.
//   5. Stamping: every value lands on the right page inside its box,
//      including a rotated page and a page with an offset crop box; the
//      certificate lists signers, consent, IPs and both fingerprints;
//      final file SHA-256 stored; signed copy reached only via a signed
//      link.
//   6. Tokens: expired (410), voided, replaced after resend, used.
//   7. Isolation between workspaces.
//   8. Templates: save a prepared PDF as a template, send it to several
//      clients (one with no email is skipped), owner signs too.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/esign-pdf.test.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { signDocFileToken } from '../api/_lib/docFiles.js';
import { cleanFields } from '../api/_lib/documents.js';
import { inspectPdfBytes } from '../api/_lib/pdfInspect.js';
import indexHandler from '../api/documents/index.js';
import idHandler from '../api/documents/[id].js';
import sendHandler from '../api/documents/send.js';
import resendHandler from '../api/documents/resend.js';
import voidHandler from '../api/documents/void.js';
import selfSignHandler from '../api/documents/self-sign.js';
import fileHandler from '../api/documents/file.js';
import saveTemplateHandler from '../api/documents/save-template.js';
import sendTemplateHandler from '../api/documents/send-template.js';
import signHandler from '../api/sign/[token].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// ── Fake Blob storage ────────────────────────────────────────────────
// Reads (server-side fetch of a *.blob.vercel-storage.com URL) are served
// from this map. Writes from @vercel/blob put() go to a local HTTP server
// (VERCEL_BLOB_API_URL) that behaves like a PUBLIC store: it refuses
// private blobs, so uploadStampedPdf's fallback is exercised too.
const BLOBS = new Map();
const STORE_HOST = 'esigntest.public.blob.vercel-storage.com';
const blobUrl = (pathname) => `https://${STORE_HOST}/${pathname}`;
let privateAttempts = 0;
const blobServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const pathname = u.searchParams.get('pathname');
    if (req.method !== 'PUT' || !pathname) { res.statusCode = 404; return res.end('{}'); }
    if (req.headers['x-vercel-blob-access'] === 'private') {
      privateAttempts++;
      res.statusCode = 400; res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: { code: 'bad_request', message: 'This store is public' } }));
    }
    const finalPath = pathname.replace(/\.pdf$/, `-${crypto.randomBytes(5).toString('hex')}.pdf`);
    BLOBS.set(blobUrl(finalPath), Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: blobUrl(finalPath), downloadUrl: blobUrl(finalPath) + '?download=1', pathname: finalPath, contentType: 'application/pdf', contentDisposition: 'inline', etag: 'x' }));
  });
});
await new Promise((r) => blobServer.listen(0, '127.0.0.1', r));
process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${blobServer.address().port}`;
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_esigntest_0123456789abcdef';
process.env.VERCEL_BLOB_RETRIES = '0';

const outbox = [];
globalThis.fetch = async (url, init = {}) => {
  const s = String(url);
  if (s.includes('api.resend.com')) {
    const body = JSON.parse(init.body || '{}');
    outbox.push({ to: [].concat(body.to).join(','), subject: body.subject, html: body.html || '', attachments: body.attachments || [] });
    return { ok: true, status: 200, json: async () => ({ id: 'em_test' }), text: async () => '{}' };
  }
  if (s.includes('.blob.vercel-storage.com/')) {
    const buf = BLOBS.get(s.split('?')[0]);
    if (!buf) return { ok: false, status: 404, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: new Headers({ 'content-length': String(buf.length) }), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};
const linkIn = (html) => (html.match(/\/sign\/([^"'\s<?]+)/) || [])[1];
const mailsFor = (email, re) => outbox.filter((m) => m.to.includes(email) && re.test(m.subject));

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, chunks: [],
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    write(c) { this.chunks.push(c); return true; },
    end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', body = {}, query = {}, cookie, headers = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'user-agent': 'esign-test-agent/1.0', 'x-forwarded-for': `198.18.7.${(ipN % 220) + 10}`, ...(cookie ? { cookie } : {}), ...headers } };
}
async function call(handler, opts) { const r = mockRes(); await handler(req(opts), r); return r; }

const STAMP = Date.now();
const OWNER = `esign-owner-${STAMP}@example.com`;
const MIA = `esign-mia-${STAMP}@example.com`;
const LEO = `esign-leo-${STAMP}@example.com`;
const OTHER_OWNER = `esign-other-${STAMP}@example.com`;
let ws, cookie, ownerId, miaId, leoId, noEmailId, ws2, cookie2;

async function makeWorkspace(email, name, slug) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${email}, 'x', ${name}, NOW()) RETURNING id`;
  const uid = u.rows[0].id;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, ${name + ' WS'}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone)
    VALUES (${w.rows[0].id}, ${name + ' Studio'}, ${slug}, 'America/Los_Angeles')
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}`;
  return { uid, wsId: w.rows[0].id, cookie: `ivy_session=${signSession(uid)}` };
}

// A real multi-page fixture: page 1 Letter, page 2 A4 with an offset crop
// box, page 3 Letter turned 90 degrees.
async function fixturePdf() {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p1 = d.addPage([612, 792]); p1.drawText('Service agreement page one', { x: 60, y: 720, size: 14, font: f });
  const p2 = d.addPage([595, 842]); p2.drawText('Page two (A4, cropped)', { x: 60, y: 760, size: 14, font: f });
  p2.setCropBox(20, 30, 540, 780);
  const p3 = d.addPage([612, 792]); p3.drawText('Page three (rotated)', { x: 60, y: 720, size: 14, font: f });
  p3.setRotation(degrees(90));
  return Buffer.from(await d.save({ useObjectStreams: false }));
}

// Display-space (top-left, fraction) position of a user-space point on a
// page, the inverse of pdfStamp.mapPage.
function toDisplayFraction(page, ux, uy) {
  const [bx, by, ex, ey] = page.view; // crop box as pdf.js sees it
  const W = ex - bx, H = ey - by;
  const rot = ((page.rotate % 360) + 360) % 360;
  let dx, dy, dW, dH;
  if (rot === 90) { dx = uy - by; dy = ux - bx; dW = H; dH = W; }
  else if (rot === 180) { dx = bx + W - ux; dy = uy - by; dW = W; dH = H; }
  else if (rot === 270) { dy = bx + W - ux; dx = by + H - uy; dW = H; dH = W; }
  else { dx = ux - bx; dy = by + H - uy; dW = W; dH = H; }
  return { fx: dx / dW, fy: dy / dH };
}

async function pdfText(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push({ page, items: tc.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] })) });
  }
  return pages;
}

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function run() {
  await ensureSchemaApplied();
  ({ uid: ownerId, wsId: ws, cookie } = await makeWorkspace(OWNER, 'Kay', `esign-${STAMP}`));
  ({ wsId: ws2, cookie: cookie2 } = await makeWorkspace(OTHER_OWNER, 'Other', `esign2-${STAMP}`));
  miaId = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${ws}, 'Mia Client', ${MIA}, 'active') RETURNING id`).rows[0].id;
  leoId = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${ws}, 'Leo Client', ${LEO}, 'active') RETURNING id`).rows[0].id;
  noEmailId = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${ws}, 'Nora NoEmail', NULL, 'active') RETURNING id`).rows[0].id;

  const pdfBytes = await fixturePdf();
  const goodUrl = blobUrl(`ws/${ws}/documents/agreement-${STAMP}.pdf`);
  BLOBS.set(goodUrl, pdfBytes);
  const junkUrl = blobUrl(`ws/${ws}/documents/junk-${STAMP}.pdf`);
  BLOBS.set(junkUrl, Buffer.from('%PDF-1.7\n' + 'not really a pdf '.repeat(40)));
  const textUrl = blobUrl(`ws/${ws}/documents/notes-${STAMP}.pdf`);
  BLOBS.set(textUrl, Buffer.from('hello this is a text file pretending '.repeat(10)));
  const lockedUrl = blobUrl(`ws/${ws}/documents/locked-${STAMP}.pdf`);
  // A trailer /Encrypt entry pointing at a real object is what marks a
  // PDF as encrypted (password or editing lock).
  BLOBS.set(lockedUrl, Buffer.from(pdfBytes.toString('latin1').replace(/\/Root (\d+) 0 R/, '/Root $1 0 R\n/Encrypt $1 0 R'), 'latin1'));
  const otherWsUrl = blobUrl(`ws/${ws2}/documents/theirs-${STAMP}.pdf`);
  BLOBS.set(otherWsUrl, pdfBytes);

  // ── 1. Upload validation ──────────────────────────────────────────
  console.log('\n[1] upload validation');
  let r = await call(indexHandler, { method: 'POST', cookie, body: { name: 'Studio agreement', kind: 'pdf' } });
  assert(r.statusCode === 201, `draft created (${r.statusCode})`);
  const doc = r.body.document;
  for (const [url, label] of [[otherWsUrl, "another workspace's file"], [junkUrl, 'a broken PDF'], [textUrl, 'a non-PDF'], [lockedUrl, 'a locked PDF'], ['https://evil.example.com/x.pdf', 'a foreign host']]) {
    r = await call(idHandler, { method: 'PATCH', cookie, query: { id: doc.id }, body: { kind: 'pdf', fileUrl: url, pageCount: 1, fields: [] } });
    assert(r.statusCode === 400 && typeof r.body?.error === 'string', `refuses ${label} (${r.statusCode}: ${r.body?.error})`);
  }
  r = await call(idHandler, { method: 'PATCH', cookie, query: { id: doc.id }, body: { kind: 'pdf', fileUrl: goodUrl, pageCount: 9, fields: [] } });
  assert(r.statusCode === 200, `accepts the real PDF (${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)})`);
  assert(r.body.document.pageCount === 3, `page count comes from the server, not the browser (${r.body.document.pageCount})`);
  const srcSha = crypto.createHash('sha256').update(pdfBytes).digest('hex');
  assert(r.body.document.sourcePdfSha256 === srcSha, 'original SHA-256 recorded');
  assert(r.body.document.pdfBlobPathname === `ws/${ws}/documents/agreement-${STAMP}.pdf`, 'blob pathname derived server side (workspace scoped)');
  let threw = false;
  try { await inspectPdfBytes(Buffer.alloc(30 * 1024 * 1024, 0x25)); } catch (e) { threw = /25 MB/.test(e.message); }
  assert(threw, 'files over 25 MB are refused before parsing');

  // ── 2. Field placement storage ────────────────────────────────────
  console.log('\n[2] field placement');
  const F = (id, type, page, x, y, w, h, extra = {}) => ({ id, type, page, x, y, w, h, required: true, signerIndex: 0, ...extra });
  const fields = [
    F('sig1', 'signature', 0, 0.10, 0.70, 0.30, 0.06),
    F('ini1', 'initial', 0, 0.80, 0.90, 0.08, 0.04),
    F('nam1', 'name', 0, 0.10, 0.80, 0.35, 0.04),
    F('em1', 'email', 0, 0.50, 0.80, 0.40, 0.04),
    F('dat1', 'date', 0, 0.50, 0.70, 0.25, 0.04),
    F('com1', 'company', 1, 0.10, 0.20, 0.40, 0.05),
    F('tit1', 'title', 1, 0.10, 0.30, 0.40, 0.05),
    F('ini2', 'initial', 1, 0.80, 0.90, 0.08, 0.04),
    F('txt1', 'text', 2, 0.10, 0.20, 0.50, 0.06, { label: 'Goals', required: false }),
    F('chk1', 'checkbox', 2, 0.10, 0.40, 0.04, 0.04, { label: 'I agree to the policy' }),
    F('drp1', 'dropdown', 2, 0.10, 0.55, 0.30, 0.05, { label: 'Plan', options: [' Monthly ', 'Yearly', 'Yearly', ''] }),
    F('sig2', 'signature', 2, 0.55, 0.75, 0.30, 0.08),
    // the business countersigns (signer 2)
    F('own1', 'signature', 1, 0.55, 0.70, 0.35, 0.07, { signerIndex: 1, label: 'Coach signature' }),
    F('own2', 'date', 1, 0.55, 0.80, 0.25, 0.04, { signerIndex: 1 }),
  ];
  r = await call(idHandler, { method: 'PATCH', cookie, query: { id: doc.id }, body: { fields: [...fields, F('bad', 'text', 7, 0.1, 0.1, 0.1, 0.1)] } });
  assert(r.statusCode === 400, 'field on a page the PDF does not have is refused');
  r = await call(idHandler, { method: 'PATCH', cookie, query: { id: doc.id }, body: { fields: Array.from({ length: 151 }, (_, i) => F(`x${i}`, 'text', 0, 0.1, 0.1, 0.1, 0.02)) } });
  assert(r.statusCode === 400, 'more than 150 fields refused');
  r = await call(idHandler, { method: 'PATCH', cookie, query: { id: doc.id }, body: { fields: [{ ...fields[0], type: 'script' }] } });
  assert(r.statusCode === 400, 'unknown field type refused');
  r = await call(idHandler, { method: 'PATCH', cookie, query: { id: doc.id }, body: { fields } });
  assert(r.statusCode === 200, 'all field types saved');
  const saved = r.body.document.fields;
  const byId = Object.fromEntries(saved.map((f) => [f.id, f]));
  assert(saved.length === fields.length, `${saved.length} fields stored`);
  assert(byId.com1.page === 1 && byId.com1.x === 0.10 && byId.com1.y === 0.20 && byId.com1.w === 0.40, 'positions stored as page fractions, exactly');
  assert(JSON.stringify(byId.drp1.options) === '["Monthly","Yearly"]', `dropdown options trimmed and de-duplicated (${JSON.stringify(byId.drp1.options)})`);
  assert(byId.own1.signerIndex === 1, 'signer assignment kept');
  const dup = cleanFields([F('same', 'text', 0, 0, 0, 0.1, 0.1), F('same', 'text', 0, 0, 0, 0.1, 0.1), F('<script>', 'text', 0, 0, 0, 0.1, 0.1)]);
  assert(new Set(dup.map((f) => f.id)).size === 3 && !dup.some((f) => f.id.includes('<')), 'duplicate or unsafe field ids replaced');

  // ── 3. Send checks ────────────────────────────────────────────────
  console.log('\n[3] send checks');
  r = await call(sendHandler, { method: 'POST', cookie, body: { id: doc.id, recipients: [{ clientId: miaId }] } });
  assert(r.statusCode === 400 && /signer 2/.test(r.body?.error || ''), `fields for signer 2 but only 1 signer is refused (${r.body?.error})`);
  r = await call(sendHandler, { method: 'POST', cookie, body: { id: doc.id, recipients: [{ clientId: miaId }, { self: true }, { clientId: leoId }] } });
  assert(r.statusCode === 400 && /Signer 3 has no fields/.test(r.body?.error || ''), 'a signer with nothing to sign is refused');
  r = await call(sendHandler, { method: 'POST', cookie, body: { id: doc.id, recipients: [{ clientId: miaId }, { self: true }] } });
  assert(r.statusCode === 200 && r.body.document.status === 'sent', `sent to Mia, then the owner (${r.statusCode})`);
  assert(r.body.document.signers[0].linkExpiresAt && new Date(r.body.document.signers[0].linkExpiresAt) > new Date(Date.now() + 29 * 864e5), 'link expiry stamped (about 30 days)');

  // ── 4. Signing ────────────────────────────────────────────────────
  console.log('\n[4] client signs on the PDF');
  const miaMail = mailsFor(MIA, /Action needed/)[0];
  const miaToken = linkIn(miaMail?.html || '');
  assert(!!miaToken, 'Mia got her signing link');
  r = await call(signHandler, { method: 'GET', query: { token: miaToken } });
  assert(r.statusCode === 200 && r.body.signer.position === 1 && r.body.signer.total === 2, 'Mia opens as signer 1 of 2');
  assert(/\/api\/documents\/file\?t=/.test(r.body.document.fileUrl || '') && !r.body.document.fileUrl.includes('blob.vercel-storage'), 'signer gets a signed file link, not the storage address');
  assert(r.body.businessName === 'Kay Studio' && /\d{4}$/.test(r.body.signedDate || ''), `business name and the date that will be stamped (${r.body.signedDate})`);
  // notifyOwnerSafe is fire-and-forget: give it a moment to land.
  const waitFor = async (fn) => { for (let i = 0; i < 40; i++) { const v = await fn(); if (v) return v; await new Promise((res) => setTimeout(res, 50)); } return null; };
  const opened = (await waitFor(async () => { const q = await sql`SELECT title, body FROM notifications WHERE user_id = ${ownerId} AND title = 'Document opened'`; return q.rows.length ? q : null; })) || { rows: [] };
  assert(opened.rows.length === 1 && opened.rows[0].body.includes('Mia Client'), 'owner notified that Mia opened it');
  const viewed = (await sql`SELECT viewed_at FROM document_signers WHERE document_id = ${doc.id} AND order_index = 0`).rows[0];
  assert(!!viewed.viewed_at, 'first open time recorded');

  const good = {
    sig1: PNG_1x1, sig2: PNG_1x1, ini1: 'MC', ini2: 'MC', nam1: 'Mia Client', em1: 'spoof@evil.example.com',
    dat1: '1999-01-01', com1: 'Acme Wellness LLC', tit1: 'Director', txt1: 'Run a 10k <b>by June</b>',
    chk1: 'true', drp1: 'Yearly', own1: 'I am not the owner', own2: '2001-01-01',
  };
  const submit = (vals, extra = {}) => call(signHandler, { method: 'POST', query: { token: miaToken }, body: { fields: Object.entries(vals).map(([id, value]) => ({ id, value })), ...extra } });
  r = await submit(good);
  assert(r.statusCode === 400 && /agree to sign electronically/.test(r.body?.error || ''), 'consent is required');
  r = await submit({ ...good, sig1: '' }, { consent: true });
  assert(r.statusCode === 400 && /Signature/.test(r.body?.error || ''), `missing required signature refused (${r.body?.error})`);
  r = await submit({ ...good, chk1: '' }, { consent: true });
  assert(r.statusCode === 400 && /tick/.test(r.body?.error || ''), 'required checkbox must be ticked');
  r = await submit({ ...good, drp1: 'Lifetime' }, { consent: true });
  assert(r.statusCode === 400 && /choices/.test(r.body?.error || ''), 'dropdown answer must be one of the options');
  r = await submit({ ...good, sig1: 'data:image/png;base64,PHN2Zz4=' }, { consent: true });
  assert(r.statusCode === 400, 'a data URL that is not a PNG is refused');
  r = await submit({ ...good, sig1: 'data:image/png;base64,' + 'A'.repeat(500_000) }, { consent: true });
  assert(r.statusCode === 400, 'an oversized signature image is refused');
  r = await call(signHandler, { method: 'POST', query: { token: miaToken }, body: { fields: 'nope', consent: true } });
  assert(r.statusCode === 400, 'malformed payload refused');
  r = await submit(good, { consent: true });
  assert(r.statusCode === 200 && r.body.nextSigner?.name, `Mia signs; handed to the owner (${r.statusCode} ${JSON.stringify(r.body).slice(0, 100)})`);
  const afterMia = Object.fromEntries((await sql`SELECT fields FROM documents WHERE id = ${doc.id}`).rows[0].fields.map((f) => [f.id, f.value]));
  assert(afterMia.dat1 !== '1999-01-01' && /\d{4}$/.test(afterMia.dat1), `Date signed set by the server (${afterMia.dat1})`);
  assert(afterMia.em1 === MIA, 'Email field is the signer\'s own address');
  assert(afterMia.own1 === '' && afterMia.own2 === '', "Mia's values for the owner's fields were ignored");
  assert(afterMia.sig1 === PNG_1x1 && afterMia.sig2 === PNG_1x1 && afterMia.ini1 === 'MC' && afterMia.ini2 === 'MC', 'adopted signature and initials applied to every matching field');
  assert(afterMia.txt1 === 'Run a 10k <b>by June</b>', 'free text stored as plain text (escaped when drawn)');
  const miaRow = (await sql`SELECT consent_at, ip, user_agent, sign_token_hash FROM document_signers WHERE document_id = ${doc.id} AND order_index = 0`).rows[0];
  assert(miaRow.consent_at && miaRow.ip && miaRow.user_agent && !miaRow.sign_token_hash, 'consent time, IP and device recorded; link spent');
  const turn = (await waitFor(async () => { const q = await sql`SELECT title FROM notifications WHERE user_id = ${ownerId} AND title = 'Your turn to sign'`; return q.rows.length ? q : null; })) || { rows: [] };
  assert(turn.rows.length === 1, 'owner told it is their turn to countersign');
  r = await submit(good, { consent: true });
  assert(r.statusCode === 404, 'used link is dead');

  console.log('\n[5] owner countersigns, final PDF stamped');
  r = await call(selfSignHandler, { method: 'POST', cookie, body: { id: doc.id } });
  const ownerToken = linkIn(r.body?.url || '');
  r = await call(signHandler, { method: 'GET', query: { token: ownerToken } });
  assert(r.statusCode === 200 && r.body.signer.isOwner === true, 'owner opens their countersign link');
  const ownerNotifs = await sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${ownerId} AND title = 'Document opened'`;
  assert(ownerNotifs.rows[0].n === 1, 'no "opened" notification for the owner opening their own link');
  r = await call(signHandler, { method: 'POST', query: { token: ownerToken }, body: { consent: true, fields: [{ id: 'own1', value: 'Kay Owner' }, { id: 'sig1', value: 'overwrite attempt' }] } });
  assert(r.statusCode === 200 && r.body.completed === true, `owner signs; document complete (${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)})`);
  const done = (await sql`SELECT * FROM documents WHERE id = ${doc.id}`).rows[0];
  assert(done.status === 'completed' && /^[0-9a-f]{64}$/.test(done.completion_hash), 'completed with a completion hash');
  const finalBytes = BLOBS.get(done.final_pdf_url);
  assert(!!finalBytes && privateAttempts >= 1 && done.final_pdf_private === false, 'signed copy stored (private store tried first, public fallback used)');
  assert(done.final_pdf_blob_pathname?.startsWith(`ws/${ws}/documents/`), 'signed copy stored under the workspace prefix');
  assert(done.final_pdf_sha256 === crypto.createHash('sha256').update(finalBytes).digest('hex'), 'signed file SHA-256 recorded');
  const ownerMail = mailsFor(OWNER, /^Signed:/)[0];
  const miaDoneMail = mailsFor(MIA, /^Signed:/)[0];
  assert(ownerMail?.attachments?.length === 1 && miaDoneMail?.attachments?.length === 1, 'owner and client both emailed the signed PDF');
  assert(Buffer.from(miaDoneMail.attachments[0].content, 'base64').equals(finalBytes), 'emailed copy is the stored copy');
  assert(!JSON.stringify(r.body).includes('blob.vercel-storage'), 'completion response has no storage address');
  const signedPush = await waitFor(async () => { const q = await sql`SELECT url FROM notifications WHERE user_id = ${ownerId} AND title = 'Document signed' AND tag = ${'doc-signed-' + doc.id}`; return q.rows[0] || null; });
  assert(signedPush?.url === `/documents?doc=${doc.id}`, `"Document signed" push opens that document (${signedPush?.url})`);

  // Every value on the right page, inside its box.
  const pages = await pdfText(finalBytes);
  assert(pages.length >= 4, `3 original pages + certificate (${pages.length} pages)`);
  const finalFields = done.fields;
  const textChecks = [['nam1', 'Mia Client'], ['em1', MIA], ['com1', 'Acme Wellness LLC'], ['tit1', 'Director'], ['ini1', 'MC'], ['ini2', 'MC'], ['drp1', 'Yearly'], ['own1', 'Kay Owner'], ['dat1', afterMia.dat1], ['txt1', 'Run a 10k <b>by June</b>']];
  for (const [fid, value] of textChecks) {
    const f = finalFields.find((x) => x.id === fid);
    const hits = [];
    pages.slice(0, 3).forEach((p, idx) => p.items.forEach((it) => { if (it.str === value) hits.push({ idx, it, p }); }));
    const onPage = hits.filter((h) => h.idx === f.page);
    const inside = onPage.some((h) => {
      const { fx, fy } = toDisplayFraction(h.p.page, h.it.x, h.it.y);
      return fx >= f.x - 0.01 && fx <= f.x + f.w + 0.01 && fy >= f.y - 0.01 && fy <= f.y + f.h + 0.01;
    });
    assert(inside, `"${value}" stamped inside its box on page ${f.page + 1}${f.page === 2 ? ' (rotated page)' : f.page === 1 ? ' (cropped A4 page)' : ''}`);
  }
  assert(!pages[0].items.some((it) => it.str === 'overwrite attempt') && !pages.some((p) => p.items.some((it) => it.str === 'I am not the owner')), "nobody's values landed in someone else's field");
  const cert = pages.slice(3).flatMap((p) => p.items.map((it) => it.str)).join('\n');
  assert(/Certificate of completion/.test(cert), 'certificate page appended');
  assert(cert.includes(MIA) && cert.includes(OWNER) && /\(Client\)/.test(cert) && /\(Business\)/.test(cert), 'certificate lists both signers with roles');
  assert(/Agreed to sign electronically/.test(cert) && /IP address/.test(cert) && /Opened/.test(cert), 'certificate shows consent, opened and IP');
  assert(cert.includes(srcSha) && cert.includes(done.completion_hash), 'certificate shows the original file fingerprint and the completion hash');
  assert(cert.includes('Kay Studio') && cert.includes(doc.id), 'certificate names the business and the document id');

  // Signed copy reached only through a signed link.
  r = await call(idHandler, { method: 'GET', cookie, query: { id: doc.id } });
  const link = r.body.document.finalPdfUrl;
  assert(/\/api\/documents\/file\?t=/.test(link) && r.body.document.finalPdfSha256 === done.final_pdf_sha256, 'owner sees a signed link and the file fingerprint');
  const t = new URL(link).searchParams.get('t');
  r = await call(fileHandler, { method: 'GET', query: { t } });
  assert(r.statusCode === 302 && r.headers.location === done.final_pdf_url && /no-store/.test(r.headers['cache-control']), 'file link redirects to the copy, no-store');
  r = await call(fileHandler, { method: 'GET', query: { t: t.slice(0, -3) + 'abc' } });
  assert(r.statusCode === 404, 'tampered file link refused');
  const expired = (await import('jsonwebtoken')).default.sign({ typ: 'docfile', d: doc.id, k: 'final' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: -10 });
  r = await call(fileHandler, { method: 'GET', query: { t: expired } });
  assert(r.statusCode === 404, 'expired file link refused');
  const wrongSecret = (await import('jsonwebtoken')).default.sign({ typ: 'docfile', d: doc.id, k: 'final' }, 'not-the-secret-not-the-secret-123', { algorithm: 'HS256', expiresIn: 60 });
  r = await call(fileHandler, { method: 'GET', query: { t: wrongSecret } });
  assert(r.statusCode === 404, 'file link signed with another key refused');

  // ── 6. Tokens ─────────────────────────────────────────────────────
  console.log('\n[6] signing links: expired, voided, replaced');
  const mk = async (name) => {
    const d = (await call(indexHandler, { method: 'POST', cookie, body: { name, kind: 'pdf' } })).body.document;
    await call(idHandler, { method: 'PATCH', cookie, query: { id: d.id }, body: { kind: 'pdf', fileUrl: goodUrl, fields: [F('s', 'signature', 0, 0.1, 0.1, 0.3, 0.06)] } });
    const s = await call(sendHandler, { method: 'POST', cookie, body: { id: d.id, recipients: [{ clientId: leoId }] } });
    assert(s.statusCode === 200, `"${name}" sent`);
    const m = mailsFor(LEO, new RegExp(name)).pop();
    return { id: d.id, token: linkIn(m?.html || '') };
  };
  const exp = await mk(`Expiring ${STAMP}`);
  await sql`UPDATE document_signers SET token_expires_at = NOW() - INTERVAL '1 minute' WHERE document_id = ${exp.id}`;
  r = await call(signHandler, { method: 'GET', query: { token: exp.token } });
  assert(r.statusCode === 410 && r.body.expired === true, 'expired link answers 410 with a friendly message');
  r = await call(resendHandler, { method: 'POST', cookie, body: { id: exp.id } });
  const fresh = linkIn(mailsFor(LEO, /Reminder/).pop()?.html || '');
  r = await call(signHandler, { method: 'GET', query: { token: fresh } });
  assert(r.statusCode === 200, 'resend mints a new link with a fresh expiry');
  r = await call(signHandler, { method: 'GET', query: { token: exp.token } });
  assert(r.statusCode === 404, 'the replaced link no longer opens (not even through the old single-signer path)');
  r = await call(signHandler, { method: 'POST', query: { token: exp.token }, body: { consent: true, fields: [{ id: 's', value: 'x' }] } });
  assert(r.statusCode === 404, 'and cannot sign');

  const vd = await mk(`Voided ${STAMP}`);
  r = await call(voidHandler, { method: 'POST', cookie, body: { id: vd.id } });
  assert(r.statusCode === 200, 'voided');
  r = await call(signHandler, { method: 'GET', query: { token: vd.token } });
  assert(r.statusCode === 404, 'voided document link is dead');
  r = await call(signHandler, { method: 'GET', query: { token: 'x'.repeat(43) } });
  assert(r.statusCode === 404, 'unknown token is 404');

  // ── 7. Isolation ──────────────────────────────────────────────────
  console.log('\n[7] other workspaces');
  r = await call(idHandler, { method: 'GET', cookie: cookie2, query: { id: doc.id } });
  assert(r.statusCode === 404, 'other workspace cannot read the document');
  r = await call(idHandler, { method: 'PATCH', cookie: cookie2, query: { id: exp.id }, body: { name: 'pwned' } });
  assert(r.statusCode === 404, 'other workspace cannot edit it');
  r = await call(saveTemplateHandler, { method: 'POST', cookie: cookie2, body: { id: doc.id } });
  assert(r.statusCode === 404, 'other workspace cannot copy it into a template');
  const theirDoc = (await call(indexHandler, { method: 'POST', cookie: cookie2, body: { name: 'Theirs', kind: 'pdf' } })).body.document;
  r = await call(idHandler, { method: 'PATCH', cookie: cookie2, query: { id: theirDoc.id }, body: { kind: 'pdf', fileUrl: goodUrl } });
  assert(r.statusCode === 400, "other workspace cannot point a document at this workspace's file");

  // ── 8. Templates ──────────────────────────────────────────────────
  console.log('\n[8] templates');
  const prep = (await call(indexHandler, { method: 'POST', cookie, body: { name: `Waiver ${STAMP}`, kind: 'pdf' } })).body.document;
  await call(idHandler, { method: 'PATCH', cookie, query: { id: prep.id }, body: { kind: 'pdf', fileUrl: goodUrl, fields: [F('s', 'signature', 0, 0.1, 0.1, 0.3, 0.06), F('n', 'name', 0, 0.1, 0.2, 0.3, 0.04)] } });
  r = await call(saveTemplateHandler, { method: 'POST', cookie, body: { id: prep.id, name: `Waiver template ${STAMP}` } });
  assert(r.statusCode === 201 && r.body.template.isTemplate === true && r.body.template.fields.length === 2 && r.body.template.pageCount === 3, 'prepared PDF saved as a template (fields + file kept)');
  const tpl = r.body.template;
  r = await call(indexHandler, { method: 'GET', cookie, query: { templates: '1' } });
  assert(r.body.documents.some((d) => d.id === tpl.id), 'template listed under templates');
  r = await call(sendTemplateHandler, { method: 'POST', cookie, body: { templateId: tpl.id, clientIds: [miaId, leoId, noEmailId] } });
  assert(r.statusCode === 200 && r.body.sent.length === 2 && r.body.skipped.length === 1 && r.body.skipped[0].reason === 'no email', `sent to 2 clients, skipped the one with no email (${JSON.stringify(r.body).slice(0, 140)})`);
  const copies = await sql`SELECT recipient_client_id, status, template_id, file_url, page_count FROM documents WHERE template_id = ${tpl.id}`;
  assert(copies.rows.length === 2 && copies.rows.every((c) => c.status === 'sent' && c.file_url === goodUrl && c.page_count === 3), 'each client got their own sent copy of the PDF');
  r = await call(sendTemplateHandler, { method: 'POST', cookie, body: { templateId: tpl.id, clientIds: [miaId], ownerSigns: 'last' } });
  assert(r.statusCode === 400, 'owner-signs on a one-signer template is refused (no fields for the owner)');
  r = await call(sendTemplateHandler, { method: 'POST', cookie: cookie2, body: { templateId: tpl.id, clientIds: [miaId] } });
  assert(r.statusCode === 400, "other workspace cannot send this workspace's template");
  r = await call(sendTemplateHandler, { method: 'POST', cookie, body: { templateId: tpl.id, clientIds: Array.from({ length: 51 }, () => crypto.randomUUID()) } });
  assert(r.statusCode === 400, 'more than 50 clients at once refused');

  blobServer.close();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('esign-pdf test crashed:', e); process.exit(1); });
