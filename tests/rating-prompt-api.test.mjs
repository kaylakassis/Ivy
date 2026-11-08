// App Store rating prompt, server side: /api/me/rating-prompt stamps and
// reads users.rating_prompted_at (so a reinstall does not ask sooner than
// 120 days) and returns the partner numbers one win rule needs. Owners
// only; nothing crosses workspaces.
// Run: node --import ./tests/bootstrap.mjs ./tests/rating-prompt-api.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import handler from '../api/me/rating-prompt.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const mkRes = () => { const r = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { r.headers[k] = v; }, getHeader(k) { return r.headers[k]; }, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; };

async function user(tag) {
  const u = await sql.query(
    `INSERT INTO users (email, password_hash, name, email_verified_at) VALUES ($1, 'x', 'Someone', NOW()) RETURNING id`,
    [`rpa-${tag}-${S}@example.com`]);
  return u.rows[0].id;
}
async function owner(tag) {
  const id = await user(tag);
  const w = await sql.query(
    `INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
     VALUES ($1, 'WS', 'active', NOW() + INTERVAL '20 days', NOW()) RETURNING id`, [id]);
  return { id, workspaceId: w.rows[0].id };
}
async function call(method, userId, { origin = true } = {}) {
  const res = mkRes();
  const headers = { host: 'localhost' };
  if (userId) headers.cookie = `ivy_session=${await signSession(userId)}`;
  // origin: true = our own site; false = a foreign page (cross-site POST).
  headers.origin = origin ? (process.env.APP_URL || 'http://localhost') : 'https://evil.example';
  await handler({ method, headers, body: '{}', url: '/api/me/rating-prompt', query: {} }, res);
  return res;
}

async function main() {
  await ensureSchemaApplied();
  const a = await owner('a');
  const b = await owner('b');
  const client = { id: await user('client') };

  console.log('\n[1] auth and method');
  assert((await call('GET', null)).statusCode === 401, 'anonymous GET → 401');
  assert((await call('POST', null)).statusCode === 401, 'anonymous POST → 401');
  assert((await call('DELETE', a.id)).statusCode === 405, 'DELETE → 405');
  const foreign = await call('POST', a.id, { origin: false });
  assert(foreign.statusCode === 403, `cross-site POST → 403 (got ${foreign.statusCode})`);
  const ar = await sql`SELECT rating_prompted_at FROM users WHERE id = ${a.id}`;
  assert(ar.rows[0].rating_prompted_at === null, 'cross-site POST stamped nothing');

  console.log('\n[2] read before any ask');
  let r = await call('GET', a.id);
  assert(r.statusCode === 200 && r.body.ratingPromptedAt === null, 'owner never asked: ratingPromptedAt null');
  assert(r.body.partner === null, 'partner never turned on: partner null');
  r = await call('GET', client.id);
  assert(r.statusCode === 200 && r.body.ratingPromptedAt === null && r.body.partner === null, 'non-owner can read (null, null)');

  console.log('\n[3] stamp');
  r = await call('POST', a.id);
  assert(r.statusCode === 200 && r.body.ok === true && r.body.ratingPromptedAt, 'owner POST stamps the date');
  const first = r.body.ratingPromptedAt;
  const row = await sql`SELECT rating_prompted_at FROM users WHERE id = ${a.id}`;
  assert(row.rows[0].rating_prompted_at && Date.now() - new Date(row.rows[0].rating_prompted_at).getTime() < 60_000, 'users.rating_prompted_at is now');
  r = await call('GET', a.id);
  assert(new Date(r.body.ratingPromptedAt).getTime() === new Date(first).getTime(), 'GET returns the stamp');
  r = await call('POST', a.id);
  assert(r.statusCode === 200 && new Date(r.body.ratingPromptedAt) >= new Date(first), 'second POST is harmless (moves the stamp forward)');
  r = await call('POST', client.id);
  assert(r.statusCode === 403, 'client (no workspace) POST → 403');
  const crow = await sql`SELECT rating_prompted_at FROM users WHERE id = ${client.id}`;
  assert(crow.rows[0].rating_prompted_at === null, 'client row untouched');

  console.log('\n[4] isolation');
  r = await call('GET', b.id);
  assert(r.body.ratingPromptedAt === null, "owner B does not see owner A's stamp");
  await sql`INSERT INTO partner_events (workspace_id, user_id, event, source, created_at) VALUES (${a.workspaceId}, ${a.id}, 'turned_on', 'settings', NOW() - INTERVAL '9 days')`;
  const ev = await sql`INSERT INTO partner_events (workspace_id, user_id, event, kind, source, item_count) VALUES (${a.workspaceId}, ${a.id}, 'sent', 'weekly', 'cron', 3) RETURNING id`;
  for (let i = 0; i < 3; i++) {
    await sql`INSERT INTO partner_mentions (event_id, workspace_id, signal_key, item_ids, cleared_at, settled)
              VALUES (${ev.rows[0].id}, ${a.workspaceId}, ${'overdue:' + i}, '[]'::jsonb, NOW(), TRUE)`;
  }
  await sql`INSERT INTO partner_mentions (event_id, workspace_id, signal_key, item_ids) VALUES (${ev.rows[0].id}, ${a.workspaceId}, 'open', '[]'::jsonb)`;
  r = await call('GET', a.id);
  assert(r.body.partner && r.body.partner.clearedCount === 3, 'owner A: 3 cleared mentions counted (the open one is not)');
  assert(r.body.partner && Date.now() - new Date(r.body.partner.onSince).getTime() > 8 * 86400e3, 'owner A: partner on since 9 days ago');
  r = await call('GET', b.id);
  assert(r.body.partner === null, "owner B sees none of A's partner data");

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
