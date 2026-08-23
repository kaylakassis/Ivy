// Portal business hide/unhide: a client can hide a business connection
// from their portal without touching the business's own records.
// Run: node --import ./tests/bootstrap.mjs ./tests/portal-hide-business.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { myClientIds } from '../api/_lib/clientPortal.js';
import hideHandler from '../api/me/businesses/hide.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  \u2713', l); } else { fail++; console.log('  \u2717', l); } };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });

function mockRes() {
  return { statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; } };
}
const req = (cookie, body) => ({ method: 'POST', url: '/t', query: {}, body,
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
    'x-forwarded-for': '198.18.5.9', ...(cookie ? { cookie } : {}) } });

const STAMP = Date.now();
const ids = { users: [] };
async function run() {
  await ensureSchemaApplied();
  const owner = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`ph-owner-${STAMP}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const clientUser = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`ph-client-${STAMP}@example.com`}, 'x', 'Client', NOW()) RETURNING id`;
  const stranger = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`ph-stranger-${STAMP}@example.com`}, 'x', 'Stranger', NOW()) RETURNING id`;
  ids.users.push(owner.rows[0].id, clientUser.rows[0].id, stranger.rows[0].id);
  const ws = await sql`INSERT INTO workspaces (owner_id, name) VALUES (${owner.rows[0].id}, 'Fit Biz') RETURNING id`;
  const cl = await sql`INSERT INTO clients (workspace_id, name, email, stage)
    VALUES (${ws.rows[0].id}, 'Kayla K', ${`ph-client-${STAMP}@example.com`}, 'active') RETURNING id`;
  const me = { id: clientUser.rows[0].id, email: `ph-client-${STAMP}@example.com`, email_verified_at: new Date() };

  console.log('\n[1] auto-claim links, hide removes from portal');
  let ms = await myClientIds(me);
  assert(ms.some((m) => m.clientId === cl.rows[0].id), 'auto-claimed into portal via verified email');

  let r = mockRes();
  await hideHandler(req(`ivy_session=${signSession(stranger.rows[0].id)}`, { clientId: cl.rows[0].id }), r);
  assert(r.statusCode === 400, `a DIFFERENT user cannot hide my connection (got ${r.statusCode})`);

  r = mockRes();
  await hideHandler(req(`ivy_session=${signSession(me.id)}`, { clientId: cl.rows[0].id }), r);
  assert(r.statusCode === 200 && r.body.hidden === true, `owner of the link hides ok (got ${r.statusCode})`);

  ms = await myClientIds(me);
  assert(!ms.some((m) => m.clientId === cl.rows[0].id), 'hidden business gone from portal');
  const bizRow = await sql`SELECT name, email, user_id FROM clients WHERE id = ${cl.rows[0].id}`;
  assert(bizRow.rows[0].name === 'Kayla K' && bizRow.rows[0].user_id === me.id,
    "business's own client record untouched (CRM intact)");

  console.log('\n[2] unhide restores');
  r = mockRes();
  await hideHandler(req(`ivy_session=${signSession(me.id)}`, { clientId: cl.rows[0].id, hidden: false }), r);
  ms = await myClientIds(me);
  assert(ms.some((m) => m.clientId === cl.rows[0].id), 'unhide restores the connection + history');
}
async function cleanup() {
  for (const uid of ids.users) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${uid}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
  }
}
run().catch((e) => { fail++; console.log('  \u2717 threw:', e.message); })
  .finally(async () => { await cleanup().catch(() => {});
    console.log(`\n Pass: ${pass}  Fail: ${fail}`); process.exit(fail === 0 ? 0 : 1); });
