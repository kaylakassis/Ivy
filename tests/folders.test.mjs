// Folders (projects) inside Clients: create a folder for a client, see
// which of that client's items can be filed, file an invoice and a
// booking, read them back, take one out, and confirm another
// workspace can't touch any of it.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/folders.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import listHandler from '../api/projects/index.js';
import oneHandler from '../api/projects/[id].js';
import linkHandler from '../api/projects/[id]/link.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

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
function req({ method = 'GET', body = {}, query = {}, cookie } = {}) {
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'user-agent': 'test-agent', 'x-forwarded-for': '198.18.2.9', ...(cookie ? { cookie } : {}) } };
}

const STAMP = Date.now();
async function owner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`folders-${tag}-${STAMP}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.rows[0].id}, 'Folders WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return { userId: u.rows[0].id, wsId: w.rows[0].id, cookie: `ivy_session=${signSession(u.rows[0].id)}` };
}

async function run() {
  await ensureSchemaApplied();
  const a = await owner('a');
  const b = await owner('b');

  const mia = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${a.wsId}, 'Mia Smith', ${`mia-${STAMP}@example.com`}, 'active') RETURNING id`).rows[0].id;
  const zed = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${a.wsId}, 'Zed Other', ${`zed-${STAMP}@example.com`}, 'active') RETURNING id`).rows[0].id;
  const invMia = (await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, status, items, tax_rate, discount)
    VALUES (${a.wsId}, ${`F-${STAMP}-1`}, ${mia}, 'Mia Smith', 'sent', '[{"quantity":2,"rate":150}]'::jsonb, 0, 0) RETURNING id`).rows[0].id;
  const invZed = (await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, status, items, tax_rate, discount)
    VALUES (${a.wsId}, ${`F-${STAMP}-2`}, ${zed}, 'Zed Other', 'draft', '[]'::jsonb, 0, 0) RETURNING id`).rows[0].id;
  const bookMia = (await sql`INSERT INTO bookings (workspace_id, client_id, client_name, date, start_min, end_min)
    VALUES (${a.wsId}, ${mia}, 'Mia Smith', '2026-10-02', 600, 660) RETURNING id`).rows[0].id;

  console.log('\n[1] create a folder for Mia');
  let r = mockRes();
  await listHandler(req({ method: 'POST', cookie: a.cookie, body: { name: 'Smith wedding', clientId: mia } }), r);
  assert(r.statusCode === 201 || r.statusCode === 200, `created (got ${r.statusCode}: ${JSON.stringify(r.body).slice(0, 120)})`);
  const folder = r.body.project;
  assert(folder?.clientId === mia && folder?.clientName === 'Mia Smith', 'folder belongs to Mia');

  console.log('\n[2] candidates are scoped to her');
  r = mockRes();
  await linkHandler(req({ method: 'GET', cookie: a.cookie, query: { id: folder.id } }), r);
  assert(r.statusCode === 200, `candidates ok (got ${r.statusCode})`);
  assert(r.body.scopedToClient === true, 'scoped to the client');
  const invIds = (r.body.candidates.invoices || []).map((x) => x.id);
  assert(invIds.includes(invMia) && !invIds.includes(invZed), "offers Mia's invoice, not Zed's");
  assert((r.body.candidates.bookings || []).some((x) => x.id === bookMia), "offers Mia's booking");
  assert(r.body.candidates.invoices.find((x) => x.id === invMia)?.total === 300, 'invoice total computed (300)');

  console.log('\n[3] file an invoice and a booking');
  r = mockRes();
  await linkHandler(req({ method: 'POST', cookie: a.cookie, query: { id: folder.id }, body: { type: 'invoices', id: invMia } }), r);
  assert(r.statusCode === 200 && r.body.linked === true, 'invoice filed');
  r = mockRes();
  await linkHandler(req({ method: 'POST', cookie: a.cookie, query: { id: folder.id }, body: { type: 'bookings', id: bookMia } }), r);
  assert(r.statusCode === 200, 'booking filed');
  r = mockRes();
  await linkHandler(req({ method: 'POST', cookie: a.cookie, query: { id: folder.id }, body: { type: 'gizmos', id: invMia } }), r);
  assert(r.statusCode === 400, 'unknown type rejected');

  console.log('\n[4] the folder shows what is inside');
  r = mockRes();
  await oneHandler(req({ method: 'GET', cookie: a.cookie, query: { id: folder.id } }), r);
  assert(r.statusCode === 200, 'folder read');
  assert(r.body.linked.invoices.length === 1 && r.body.linked.bookings.length === 1, 'one invoice + one booking inside');
  assert(r.body.project.counts.invoices === 1, 'counts reflect contents');
  r = mockRes();
  await linkHandler(req({ method: 'GET', cookie: a.cookie, query: { id: folder.id } }), r);
  assert(!(r.body.candidates.invoices || []).some((x) => x.id === invMia), 'filed invoice no longer offered');
  r = mockRes();
  await listHandler(req({ method: 'GET', cookie: a.cookie, query: {} }), r);
  const listed = (r.body.projects || []).find((p) => p.id === folder.id);
  assert(listed?.counts?.invoices === 1 && listed?.counts?.bookings === 1, 'list view carries counts');

  console.log('\n[5] take the invoice out');
  r = mockRes();
  await linkHandler(req({ method: 'DELETE', cookie: a.cookie, query: { id: folder.id }, body: { type: 'invoices', id: invMia } }), r);
  assert(r.statusCode === 200 && r.body.linked === false, 'invoice taken out');
  const inv = await sql`SELECT project_id FROM invoices WHERE id = ${invMia}`;
  assert(inv.rows[0].project_id === null, 'invoice itself still exists, unfiled');

  console.log('\n[6] another workspace cannot see or touch it');
  r = mockRes();
  await linkHandler(req({ method: 'GET', cookie: b.cookie, query: { id: folder.id } }), r);
  assert(r.statusCode === 404, `other workspace gets 404 (got ${r.statusCode})`);
  r = mockRes();
  await linkHandler(req({ method: 'POST', cookie: b.cookie, query: { id: folder.id }, body: { type: 'bookings', id: bookMia } }), r);
  assert(r.statusCode === 404, 'other workspace cannot file into it');
  r = mockRes();
  await linkHandler(req({ method: 'POST', cookie: a.cookie, query: { id: folder.id }, body: { type: 'invoices', id: '00000000-0000-0000-0000-000000000000' } }), r);
  assert(r.statusCode === 404, 'unknown item is 404');

  console.log('\n[7] delete the folder, contents survive');
  r = mockRes();
  await oneHandler(req({ method: 'DELETE', cookie: a.cookie, query: { id: folder.id } }), r);
  assert(r.statusCode === 204 || r.statusCode === 200, `deleted (got ${r.statusCode})`);
  const bk = await sql`SELECT id, project_id FROM bookings WHERE id = ${bookMia}`;
  assert(bk.rows.length === 1 && bk.rows[0].project_id === null, 'booking still exists, unfiled');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
