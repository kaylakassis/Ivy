// Admin tool for owners with two business records (a sign-up race from
// before businesses were one per owner): lists both with counts, removes
// only safe ones, and adds the one-per-owner unique index afterwards.
// Run: node --import ./tests/bootstrap.mjs ./tests/admin-duplicate-workspaces.test.mjs
process.env.ADMIN_SECRET ||= 'test-admin-secret';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import handler from '../api/admin/users/[id]/workspaces.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const mockRes = () => ({
  statusCode: 200, headers: {}, body: null,
  status(c) { this.statusCode = c; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
  json(o) { this.body = o; return this; }, end() { return this; },
});
const req = ({ method = 'GET', body = {}, query = {}, headers = {} } = {}) => ({
  method, url: '/test', query, body,
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': '198.51.100.77', ...headers },
});
const call = async (o) => { const r = mockRes(); await handler(req(o), r); return r; };
const ADMIN = { 'x-admin-secret': process.env.ADMIN_SECRET };

await ensureSchemaApplied();
const tag = `dupws-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const mkUser = async (n) => (await sql`INSERT INTO users (email, password_hash, name) VALUES (${`${tag}-${n}@example.com`}, 'x', ${n}) RETURNING id`).rows[0].id;
const irene = await mkUser('irene');
const other = await mkUser('other');
let hadIndex = false;
try {
  // Recreate the pre-fix state: no unique index, two businesses for one owner.
  hadIndex = (await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_workspaces_owner'`).rows.length > 0;
  await sql`DROP INDEX IF EXISTS uq_workspaces_owner`;
  const w1 = (await sql`INSERT INTO workspaces (owner_id, created_at) VALUES (${irene}, NOW() - INTERVAL '10 seconds') RETURNING id`).rows[0].id;
  const w2 = (await sql`INSERT INTO workspaces (owner_id) VALUES (${irene}) RETURNING id`).rows[0].id;
  await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${w1}, 'Real Client', 'active')`;
  const ow = (await sql`INSERT INTO workspaces (owner_id) VALUES (${other}) RETURNING id`).rows[0].id;

  console.log('\n[1] access');
  let r = await call({ query: { id: irene } });
  assert(r.statusCode === 401 || r.statusCode === 403, `no admin → refused (${r.statusCode})`);
  const ownerCookie = `ivy_session=${signSession(other)}`;
  r = await call({ query: { id: irene }, headers: { cookie: ownerCookie } });
  assert(r.statusCode === 403, `a regular owner → 403 (${r.statusCode})`);

  console.log('\n[2] list');
  r = await call({ query: { id: irene }, headers: ADMIN });
  const list = r.body?.workspaces || [];
  assert(r.statusCode === 200 && list.length === 2, 'both businesses listed');
  assert(list[0].id === w1 && list[0].inUse && !list[1].inUse, 'oldest first and marked in use');
  assert(list[0].dataRows === 1 && list[0].counts.clients === 1 && list[1].dataRows === 0, 'counts show where the data is');
  assert(!JSON.stringify(r.body).includes('Real Client'), 'no client names in the response');

  console.log('\n[3] removal rules');
  r = await call({ method: 'POST', query: { id: irene }, body: { removeWorkspaceId: ow }, headers: ADMIN });
  assert(r.statusCode === 404, 'another person\'s business cannot be removed here');
  r = await call({ method: 'POST', query: { id: irene }, body: { removeWorkspaceId: w1 }, headers: ADMIN });
  assert(r.statusCode === 400 && /records/.test(r.body?.error || ''), 'one with data needs explicit confirmation');
  await sql`UPDATE workspaces SET subscription_status = 'active', stripe_subscription_id = 'sub_live_x' WHERE id = ${w2}`;
  r = await call({ method: 'POST', query: { id: irene }, body: { removeWorkspaceId: w2 }, headers: ADMIN });
  assert(r.statusCode === 400 && /plan/.test(r.body?.error || ''), 'one with a live plan is refused');
  await sql`UPDATE workspaces SET subscription_status = 'incomplete', stripe_subscription_id = NULL WHERE id = ${w2}`;

  console.log('\n[4] remove the empty one');
  r = await call({ method: 'POST', query: { id: irene }, body: { removeWorkspaceId: w2 }, headers: ADMIN });
  assert(r.statusCode === 200 && r.body?.removed === w2, 'empty duplicate removed');
  const left = (await sql`SELECT id FROM workspaces WHERE owner_id = ${irene}`).rows;
  assert(left.length === 1 && left[0].id === w1, 'the business with the data remains');
  assert((await sql`SELECT 1 FROM clients WHERE workspace_id = ${w1}`).rows.length === 1, 'its client is untouched');
  r = await call({ method: 'POST', query: { id: irene }, body: { removeWorkspaceId: w1, allowData: true }, headers: ADMIN });
  assert(r.statusCode === 400, 'the last business can never be removed');

  console.log('\n[5] one-per-owner index restored when no duplicates remain');
  const dupLeft = (await sql`SELECT 1 FROM workspaces GROUP BY owner_id HAVING COUNT(*) > 1 LIMIT 1`).rows.length > 0;
  const idx = (await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_workspaces_owner'`).rows.length > 0;
  assert(dupLeft || idx, `index created (${idx}) unless other duplicates exist (${dupLeft})`);
} finally {
  await sql`DELETE FROM users WHERE id IN (${irene}, ${other})`;
  if (hadIndex) {
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_owner ON workspaces(owner_id)`.catch(() => {});
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
