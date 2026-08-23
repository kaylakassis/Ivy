// Deleted accounts go dark everywhere public. Account deletion is a
// SOFT delete (users.deleted_at + mangled email) that leaves the
// workspace behind - previously the booking page, website shop, and
// Discover listing all stayed live forever. Now:
//   1. Discover lists only living owners of OPERATING workspaces with
//      real content (>=1 public service or active products).
//   2. Public booking page 404s once the owner is deleted.
//   3. Website shop endpoints 404 once the owner is deleted.
//   4. A lapsed (cancelled) workspace drops out of Discover but its
//      direct booking link still works - only deletion kills links.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/deleted-owner-visibility.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import discoverHandler from '../api/me/discover.js';
import publicSlugHandler from '../api/calendar/public/[slug].js';
import productsHandler from '../api/site/[handle]/products.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });

function mockRes() {
  return { statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; } };
}
const req = ({ cookie, query = {} } = {}) => ({ method: 'GET', url: '/t', query, body: {},
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
    'x-forwarded-for': '198.18.7.7', ...(cookie ? { cookie } : {}) } });

const STAMP = Date.now();
const ids = { users: [] };

async function mkBiz(label, { status = 'active', services = 1 } = {}) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`dov-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW()) RETURNING id`;
  ids.users.push(u.rows[0].id);
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end)
    VALUES (${u.rows[0].id}, ${label}, ${status}, NOW() + INTERVAL '30 days') RETURNING id`;
  const slug = `dov-${label}-${STAMP}`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, discoverable)
    VALUES (${w.rows[0].id}, ${label}, ${slug}, TRUE)
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}, discoverable = TRUE`;
  for (let i = 0; i < services; i++) {
    await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility)
      VALUES (${w.rows[0].id}, ${'Svc ' + i}, 50, 60, 'public')`;
  }
  // Snapshot row (normally written by the discover-refresh cron).
  await sql`INSERT INTO discover_snapshots (workspace_id, service_count, refreshed_at)
    VALUES (${w.rows[0].id}, ${services}, NOW())
    ON CONFLICT (workspace_id) DO UPDATE SET service_count = ${services}`;
  await sql`INSERT INTO websites (workspace_id, handle, business_name, launched, published_at)
    VALUES (${w.rows[0].id}, ${slug}, ${label}, TRUE, NOW())
    ON CONFLICT (workspace_id) DO UPDATE SET handle = ${slug}, published_at = NOW()`;
  return { userId: u.rows[0].id, wsId: w.rows[0].id, slug };
}

async function run() {
  await ensureSchemaApplied();
  // A portal viewer to call Discover with.
  const viewer = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`dov-viewer-${STAMP}@example.com`}, 'x', 'Viewer', NOW()) RETURNING id`;
  ids.users.push(viewer.rows[0].id);
  const cookie = `ivy_session=${signSession(viewer.rows[0].id)}`;

  const alive   = await mkBiz('alive');
  const doomed  = await mkBiz('doomed');
  const empty   = await mkBiz('empty', { services: 0 });
  const lapsed  = await mkBiz('lapsed', { status: 'cancelled' });

  const namesFrom = (r) => (r.body?.businesses || r.body?.results || []).map((b) => b.bizName || b.name);

  console.log('\n[1] baseline: alive business lists, empty + lapsed do not');
  let r = mockRes();
  await discoverHandler(req({ cookie }), r);
  let names = namesFrom(r);
  assert(r.statusCode === 200, `discover ok (got ${r.statusCode})`);
  assert(names.includes('alive'), `alive listed (${names.length} rows)`);
  assert(names.includes('doomed'), 'doomed listed while its owner lives');
  assert(!names.includes('empty'), '0-service shell NOT listed');
  assert(!names.includes('lapsed'), 'cancelled workspace NOT listed');

  console.log('\n[2] soft-delete the owner → gone from Discover');
  await sql`UPDATE users SET deleted_at = NOW() WHERE id = ${doomed.userId}`;
  r = mockRes();
  await discoverHandler(req({ cookie }), r);
  names = namesFrom(r);
  assert(!names.includes('doomed'), 'deleted-owner business no longer listed');
  assert(names.includes('alive'), 'alive business unaffected');

  console.log('\n[3] deleted owner → public booking page dark');
  r = mockRes();
  await publicSlugHandler(req({ query: { slug: doomed.slug } }), r);
  assert(r.statusCode === 404, `booking page 404 (got ${r.statusCode})`);
  r = mockRes();
  await publicSlugHandler(req({ query: { slug: alive.slug } }), r);
  assert(r.statusCode === 200, `living booking page still 200 (got ${r.statusCode})`);
  r = mockRes();
  await publicSlugHandler(req({ query: { slug: lapsed.slug } }), r);
  assert(r.statusCode === 200, 'lapsed-but-not-deleted direct link still works (deliberate)');

  console.log('\n[4] deleted owner → shop endpoints dark');
  r = mockRes();
  await productsHandler(req({ query: { handle: doomed.slug } }), r);
  assert(r.statusCode === 404, `products 404 for deleted owner (got ${r.statusCode})`);
  r = mockRes();
  await productsHandler(req({ query: { handle: alive.slug } }), r);
  assert(r.statusCode === 200, `products 200 for living owner (got ${r.statusCode})`);
}

async function cleanup() {
  for (const uid of ids.users) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${uid}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
  }
}

run().catch((e) => { fail++; console.log('  ✗ threw:', e.message, '\n', e.stack); })
  .finally(async () => { await cleanup().catch(() => {});
    console.log(`\n────────────────────────────\nPass: ${pass}  Fail: ${fail}`);
    process.exit(fail === 0 ? 0 : 1); });
