// Adding a client twice does not create two records.
// Run: node --import ./tests/bootstrap.mjs ./tests/client-dedupe.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import handler from '../api/clients/index.js';
import { signSession } from '../api/_lib/auth.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

function makeRes() {
  return { statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s; return this; } };
}
async function owner(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`dedupe-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW())`;
  return `ivy_session=${signSession(u.rows[0].id)}`;
}
const post = async (cookie, body) => {
  const res = makeRes();
  await handler({ method: 'POST', url: '/api/clients', query: {}, body, headers: { cookie, 'content-type': 'application/json', origin: 'http://localhost:3001', host: 'localhost:3001' } }, res);
  return res;
};

async function run() {
  await ensureSchemaApplied();
  const a = await owner('a'); const b = await owner('b');
  const email = `jane-${S}@example.com`;

  let r = await post(a, { name: 'Jane Client', email, stage: 'active' });
  assert(r.statusCode === 201 || r.statusCode === 200, `first add succeeds (${r.statusCode})`);
  const firstId = r.body?.client?.id;
  r = await post(a, { name: 'Jane C.', email: email.toUpperCase(), stage: 'lead' });
  assert(r.statusCode === 409, `same email again → 409 (${r.statusCode})`);
  assert(r.body?.existingId === firstId, 'response points at the existing record');
  assert(/already in your clients/.test(r.body?.error || ''), `message is plain English (${r.body?.error})`);
  r = await post(a, { name: 'Phone Only', phone: `+1555${String(S).slice(-7)}` });
  assert(r.statusCode === 201 || r.statusCode === 200, 'phone-only client adds');
  r = await post(a, { name: 'Phone Only Again', phone: `+1555${String(S).slice(-7)}` });
  assert(r.statusCode === 409, 'same phone with no email → 409');
  r = await post(b, { name: 'Jane Elsewhere', email, stage: 'active' });
  assert(r.statusCode === 201 || r.statusCode === 200, 'another workspace may have the same email');
  const n = await sql`SELECT COUNT(*)::int AS n FROM clients WHERE lower(email) = ${email}`;
  assert(n.rows[0].n === 2, 'exactly one record per workspace');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });
