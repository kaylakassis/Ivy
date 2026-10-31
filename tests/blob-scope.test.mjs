// Blob storage is scoped per workspace.
//   • blobPathnameForWorkspace: only Vercel Blob hosts, only ws/<id>/...
//   • upload-token routes refuse a pathname outside the uploader's prefix
//   • /api/calendar/bookings/complete derives blobPathname from the URL,
//     ignores the client-supplied one, and only del()s its own objects
//     (legacy unprefixed pathnames are left in storage)
//   • /api/clients/:id gallery ignores a client-supplied blobPathname
//
// del() is observed through a local fake Blob API (VERCEL_BLOB_API_URL),
// so nothing leaves the machine.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/blob-scope.test.mjs
import http from 'node:http';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import {
  blobPathnameForWorkspace, scopedBlobPathnames, assertUploadPathname, uploadPrefix,
} from '../api/_lib/blobScope.js';
import completeHandler from '../api/calendar/bookings/complete.js';
import bookingUploadToken from '../api/calendar/bookings/upload-token.js';
import clientUploadToken from '../api/clients/upload-token.js';
import programsUploadToken from '../api/programs/upload-token.js';
import clientById from '../api/clients/[id].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake Blob API: records every delete ──
const deleted = [];
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => {
    if (req.url.startsWith('/delete')) {
      try { deleted.push(...(JSON.parse(data).urls || [])); } catch { /* ignore */ }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { if (s !== undefined) { try { this.body = JSON.parse(s); } catch { this.body = s; } } return this; },
  };
}
let ipN = 0;
function req({ method = 'POST', body = {}, query = {}, cookie } = {}) {
  ipN++;
  return { method, url: '/api/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.51.100.${(ipN % 200) + 10}`, ...(cookie ? { cookie } : {}) } };
}
const call = async (h, o) => { const r = mockRes(); await h(req(o), r); return r; };

const STAMP = Date.now();
const userIds = [];
const wsIds = [];
async function mkOwner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`blobscope-${tag}-${STAMP}@example.com`}, 'x', 'Blob Owner', NOW()) RETURNING id`;
  userIds.push(u.rows[0].id);
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.rows[0].id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  wsIds.push(w.rows[0].id);
  return { userId: u.rows[0].id, workspaceId: w.rows[0].id, cookie: `ivy_session=${signSession(u.rows[0].id)}` };
}
const HOST = 'https://abc123store.public.blob.vercel-storage.com';

async function run() {
  await ensureSchemaApplied();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.VERCEL_BLOB_RETRIES = '0';
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_abc123store_testsecretvalue0000000000';

  const A = await mkOwner('a');
  const B = await mkOwner('b');
  const pA = uploadPrefix(A.workspaceId);
  const pB = uploadPrefix(B.workspaceId);

  console.log('\n[1] blobPathnameForWorkspace');
  assert(blobPathnameForWorkspace(`${HOST}/${pA}bookings/x/completion-1-abc.png`, A.workspaceId) === `${pA}bookings/x/completion-1-abc.png`, 'own URL on a public blob host → pathname');
  assert(blobPathnameForWorkspace(`https://abc123store.blob.vercel-storage.com/${pA}f.pdf`, A.workspaceId) === `${pA}f.pdf`, 'own URL on a private blob host → pathname');
  assert(blobPathnameForWorkspace(`${pA}f.pdf`, A.workspaceId) === `${pA}f.pdf`, 'own bare pathname → pathname');
  assert(blobPathnameForWorkspace(`${HOST}/${pA}a%20b.png`, A.workspaceId) === `${pA}a b.png`, 'URL-encoded name decoded');
  assert(blobPathnameForWorkspace(`${HOST}/${pB}f.pdf`, A.workspaceId) === null, "another workspace's URL → null");
  assert(blobPathnameForWorkspace(`${pB}f.pdf`, A.workspaceId) === null, "another workspace's pathname → null");
  assert(blobPathnameForWorkspace(`https://evil.example.com/${pA}f.pdf`, A.workspaceId) === null, 'foreign host → null');
  assert(blobPathnameForWorkspace(`https://blob.vercel-storage.com.evil.example/${pA}f.pdf`, A.workspaceId) === null, 'look-alike host → null');
  assert(blobPathnameForWorkspace(`http://abc123store.public.blob.vercel-storage.com/${pA}f.pdf`, A.workspaceId) === null, 'plain http → null');
  assert(blobPathnameForWorkspace('bookings/legacy-123.png', A.workspaceId) === null, 'legacy unprefixed pathname → null');
  assert(blobPathnameForWorkspace(`${pA}../${pB}f.pdf`, A.workspaceId) === null, 'path traversal → null');
  assert(blobPathnameForWorkspace(pA, A.workspaceId) === null, 'the prefix folder itself → null');
  assert(blobPathnameForWorkspace(`//evil.example/${pA}f`, A.workspaceId) === null, 'protocol-relative → null');
  assert(blobPathnameForWorkspace(`${pA}f.pdf`, null) === null && blobPathnameForWorkspace(null, A.workspaceId) === null, 'missing inputs → null');
  assert(JSON.stringify(scopedBlobPathnames([`${pA}1`, `${pB}2`, 'legacy/3', `${pA}1`], A.workspaceId)) === JSON.stringify([`${pA}1`]), 'scopedBlobPathnames keeps only own, de-duplicated');
  let threw = false;
  try { assertUploadPathname(`${pB}x.png`, A.workspaceId); } catch (e) { threw = e.status === 400; }
  assert(threw, 'assertUploadPathname refuses a foreign prefix with 400');

  console.log('\n[2] upload-token routes never mint a token for another workspace\'s folder');
  const tokenBody = (pathname) => ({ type: 'blob.generate-client-token', payload: { pathname, clientPayload: null, multipart: false } });
  for (const [label, handler] of [['bookings', bookingUploadToken], ['clients', clientUploadToken], ['programs', programsUploadToken]]) {
    let r = await call(handler, { cookie: A.cookie, body: tokenBody(`${pA}${label}/f.png`) });
    assert(r.statusCode === 200 && typeof r.body?.clientToken === 'string', `${label}: own prefix → token (${r.statusCode} ${JSON.stringify(r.body).slice(0, 60)})`);
    r = await call(handler, { cookie: A.cookie, body: tokenBody(`${pB}${label}/f.png`) });
    assert(r.statusCode === 400 && !r.body?.clientToken, `${label}: B's prefix → 400 (${r.statusCode})`);
    // The iPhone build already in the App Store uploads unprefixed; it must
    // keep working. Such files can never be deleted by a user action.
    r = await call(handler, { cookie: A.cookie, body: tokenBody(`${label}/legacy-${STAMP}.png`) });
    assert(r.statusCode === 200 && typeof r.body?.clientToken === 'string', `${label}: legacy unprefixed pathname still uploads (${r.statusCode})`);
    r = await call(handler, { cookie: A.cookie, body: tokenBody(`ws/${label}-not-a-workspace/f.png`) });
    assert(r.statusCode === 400, `${label}: any other ws/ folder → 400 (${r.statusCode})`);
    r = await call(handler, { cookie: A.cookie, body: tokenBody(`${label}/../${pB}x.png`) });
    assert(r.statusCode === 400, `${label}: traversal → 400 (${r.statusCode})`);
  }

  console.log('\n[3] completion attachments: pathname derived from URL, foreign ones never deleted');
  const bk = (await sql`INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min)
    VALUES (${A.workspaceId}, 'Blob Client', 'blob@example.com', CURRENT_DATE - 1, 600, 660) RETURNING id, date::text AS d`).rows[0];
  const ownUrl = `${HOST}/${pA}bookings/${bk.id}/completion-1-xyz.png`;
  const victimPath = `${pB}documents/contract-abc.pdf`;
  let r = await call(completeHandler, { cookie: A.cookie, body: {
    id: bk.id, occurrenceDate: bk.d, completionNotes: 'done',
    completionAttachments: [
      { url: ownUrl, blobPathname: victimPath, mimeType: 'image/png', filename: 'mine.png' },
      { url: `${HOST}/${victimPath}`, blobPathname: victimPath, mimeType: 'application/pdf', filename: 'theirs.pdf' },
      { url: `https://evil.example.com/${pA}x.png`, blobPathname: `${pA}x.png`, mimeType: 'image/png', filename: 'evil.png' },
    ],
  } });
  assert(r.statusCode === 200, `POST complete 200 (${r.statusCode} ${JSON.stringify(r.body).slice(0, 80)})`);
  let att = (await sql`SELECT completion_log FROM bookings WHERE id = ${bk.id}`).rows[0].completion_log[bk.d].attachments;
  assert(att.length === 3, 'three attachments stored');
  assert(att[0].blobPathname === `${pA}bookings/${bk.id}/completion-1-xyz.png`, 'own file: pathname derived from its URL, client value ignored');
  assert(att[1].blobPathname === null, "B's file: stored pathname null");
  assert(att[2].blobPathname === null, 'foreign-host file: stored pathname null');
  assert(!att.some((a) => a.blobPathname === victimPath), "the client-supplied victim pathname is never stored");

  // Drop everything: only the own file may be deleted.
  r = await call(completeHandler, { method: 'PATCH', cookie: A.cookie, body: { id: bk.id, occurrenceDate: bk.d, completionAttachments: [] } });
  assert(r.statusCode === 200, `PATCH complete 200 (${r.statusCode})`);
  await sleep(400);
  assert(deleted.includes(`${pA}bookings/${bk.id}/completion-1-xyz.png`), 'own orphan deleted');
  assert(!deleted.some((p) => String(p).startsWith(pB)), "nothing under B's prefix was deleted");

  // A tampered stored row (or a legacy one) never reaches del() either.
  deleted.length = 0;
  const log = { [bk.d]: { completedAt: new Date().toISOString(), notes: '', visibleToClient: true, attachments: [
    { url: `${HOST}/bookings/legacy-${STAMP}.png`, blobPathname: `bookings/legacy-${STAMP}.png` },
    { url: `${HOST}/${victimPath}`, blobPathname: victimPath },
    { url: `${HOST}/${pA}keep-me-${STAMP}.png`, blobPathname: `${pA}keep-me-${STAMP}.png` },
  ] } };
  await sql`UPDATE bookings SET completion_log = ${JSON.stringify(log)}::jsonb WHERE id = ${bk.id}`;
  // PATCH keeping the legacy file: it stays on the row with its stored pathname.
  r = await call(completeHandler, { method: 'PATCH', cookie: A.cookie, body: { id: bk.id, occurrenceDate: bk.d,
    completionAttachments: [{ url: `${HOST}/bookings/legacy-${STAMP}.png`, mimeType: 'image/png', filename: 'old.png' }] } });
  att = (await sql`SELECT completion_log FROM bookings WHERE id = ${bk.id}`).rows[0].completion_log[bk.d].attachments;
  assert(r.statusCode === 200 && att.length === 1 && att[0].blobPathname === `bookings/legacy-${STAMP}.png`, 'kept legacy attachment keeps its stored pathname');
  await sleep(400);
  assert(deleted.length === 1 && deleted[0] === `${pA}keep-me-${STAMP}.png`, `only the own dropped file deleted (${JSON.stringify(deleted)})`);
  deleted.length = 0;
  r = await call(completeHandler, { method: 'DELETE', cookie: A.cookie, body: { id: bk.id, occurrenceDate: bk.d } });
  await sleep(400);
  assert(r.statusCode === 200 && deleted.length === 0, 'undo complete: legacy unprefixed file left in storage');

  console.log('\n[4] client gallery: client-supplied blobPathname ignored');
  const cl = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${A.workspaceId}, 'Gallery Client', ${`gal-${STAMP}@example.com`}, 'active') RETURNING id`).rows[0].id;
  r = await call(clientById, { method: 'PATCH', cookie: A.cookie, query: { id: cl }, body: { galleryPhotos: [
    { url: `${HOST}/${pA}clients/gallery-1.jpg`, blobPathname: victimPath },
    { url: `${HOST}/${victimPath}`, blobPathname: victimPath },
  ] } });
  assert(r.statusCode === 200, `gallery PATCH 200 (${r.statusCode})`);
  const gal = (await sql`SELECT gallery_photos FROM clients WHERE id = ${cl}`).rows[0].gallery_photos;
  assert(gal[0].blobPathname === `${pA}clients/gallery-1.jpg`, 'own photo: pathname derived from URL');
  assert(gal[1].blobPathname === null, "B's photo: pathname null");
}

async function cleanup() {
  try {
    for (const w of wsIds) await sql`DELETE FROM workspaces WHERE id = ${w}`;
    for (const u of userIds) await sql`DELETE FROM users WHERE id = ${u}`;
  } catch (e) { console.error('cleanup:', e.message); }
  server.close();
}

run()
  .catch((e) => { fail++; console.error(e); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
