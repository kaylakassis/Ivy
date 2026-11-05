// Admin > Marketing list (api/admin/marketing-list.js).
//
//   [1] non-admins get 403 (owner, client), signed out 401, GET only
//   [2] only people who opted in and have not withdrawn are listed, with
//       account type, opted-in date + source, business name + state, plan
//   [3] withdrawing (settings switch, unsubscribe) removes them
//   [4] search narrows the list; LIKE wildcards are literal
//   [5] CSV export: header, rows, formula cells neutralised, audited
//
// Run: node --import ./tests/bootstrap.mjs ./tests/admin-marketing-list.test.mjs
process.env.ADMIN_SECRET ||= 'test-admin-secret';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { mintUnsubscribeToken } from '../api/_lib/unsubscribeToken.js';
import listHandler from '../api/admin/marketing-list.js';
import prefsHandler from '../api/me/notification-prefs.js';
import unsubscribeHandler from '../api/unsubscribe.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '{}' });

const TAG = `mktlist${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const em = (t) => `${t}-${TAG}@example.com`;
let ipN = 0;
function mkRes() {
  const chunks = [];
  return {
    statusCode: 200, headers: {}, body: null, chunks,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(o) { this.body = o; return this; },
    write(s) { chunks.push(String(s)); return true; },
    end(s) { if (s !== undefined) chunks.push(String(s)); this.ended = true; return this; },
  };
}
function mkReq({ method = 'GET', query = {}, body = {}, cookie, admin = false, origin = 'http://localhost:3000' } = {}) {
  return {
    method, url: '/api/admin/marketing-list', query, body,
    headers: {
      host: 'localhost:3000', 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${(++ipN % 200) + 20}`,
      ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}),
      ...(admin ? { 'x-admin-secret': process.env.ADMIN_SECRET } : {}),
    },
  };
}
const call = async (h, opts) => { const r = mkRes(); await h(mkReq(opts), r); return r; };
const cookieFor = (id) => `ivy_session=${signSession(id)}`;

async function person(tag, { name, consent = true, source = 'signup', biz = null, state = null, status = 'incomplete', client = false } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, marketing_consent_at, marketing_consent_source)
    VALUES (${em(tag)}, 'x', ${name || tag}, NOW(), ${consent ? new Date().toISOString() : null}, ${consent ? source : null})
    RETURNING id`).rows[0].id;
  if (biz) {
    const w = (await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, subscription_period_end)
      VALUES (${u}, ${status}, ${status === 'trialing' ? new Date(Date.now() + 5 * 864e5).toISOString() : null},
              ${status === 'active' ? new Date(Date.now() + 20 * 864e5).toISOString() : null}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${w}, ${biz}, ${`${tag}-${TAG}`.toLowerCase()})`;
    if (state) await sql`INSERT INTO workspace_profile (workspace_id, location_state) VALUES (${w}, ${state})`;
  }
  if (client) {
    const host = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${em(`${tag}host`)}, 'x', 'Host') RETURNING id`).rows[0].id;
    const w = (await sql`INSERT INTO workspaces (owner_id, subscription_status) VALUES (${host}, 'active') RETURNING id`).rows[0].id;
    await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id) VALUES (${w}, ${tag}, ${em(tag)}, 'active', ${u})`;
  }
  return u;
}
const listQ = async (q) => {
  const r = await call(listHandler, { admin: true, query: { q } });
  return r;
};

async function cleanup() {
  const { rows } = await sql.query(`SELECT id FROM users WHERE email LIKE $1`, [`%${TAG}%`]);
  for (const r of rows) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${r.id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${r.id}`.catch(() => {});
  }
}

async function run() {
  await ensureSchemaApplied();
  const owner = await person('owner', { name: 'Olive Owner', biz: 'Olive Studio', state: 'CA', status: 'trialing' });
  const payer = await person('payer', { name: 'Pat Payer', biz: 'Pat Fitness', state: 'TX', status: 'active', source: 'settings' });
  const client = await person('client', { name: 'Cleo Client', client: true });
  const evil = await person('evil', { name: '=HYPERLINK("http://x.example","click")', biz: '+SUM(A1:A2)' });
  const noConsent = await person('nope', { consent: false, biz: 'Nope Biz' });
  const deleted = await person('gone');
  await sql`UPDATE users SET deleted_at = NOW() WHERE id = ${deleted}`;
  const muted = await person('muted');
  await sql`UPDATE users SET notification_prefs = '{"email_marketing": false}'::jsonb WHERE id = ${muted}`;

  console.log('\n[1] super-admin only');
  let r = await call(listHandler, { cookie: cookieFor(noConsent) });
  assert(r.statusCode === 403, `owner gets 403 (got ${r.statusCode})`);
  r = await call(listHandler, { cookie: cookieFor(client) });
  assert(r.statusCode === 403, 'client gets 403');
  r = await call(listHandler, { cookie: cookieFor(client), query: { format: 'csv' } });
  assert(r.statusCode === 403 && r.chunks.length === 0, 'CSV export 403 for non-admin, nothing written');
  r = await call(listHandler, {});
  assert(r.statusCode === 401 || r.statusCode === 403, `signed out refused (got ${r.statusCode})`);
  r = await call(listHandler, { admin: true, method: 'POST' });
  assert(r.statusCode === 405, 'POST not allowed');

  console.log('\n[2] only people who opted in and have not withdrawn');
  r = await listQ(TAG);
  assert(r.statusCode === 200, `admin 200 (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  const ids = new Set(r.body.people.map((p) => p.id));
  assert(ids.has(owner) && ids.has(payer) && ids.has(client) && ids.has(evil), 'opted-in owner, payer, client listed');
  assert(!ids.has(noConsent) && !ids.has(deleted) && !ids.has(muted), 'no consent, deleted, unsubscribed: not listed');
  assert(r.body.total === 4, `count matches (${r.body.total})`);
  const o = r.body.people.find((p) => p.id === owner);
  assert(o.businessName === 'Olive Studio' && o.state === 'CA' && o.accountTypes.join() === 'owner'
    && o.planStatus === 'On trial' && o.sourceLabel === 'Sign-up' && !!o.optedInAt && o.email === em('owner'), 'owner row: business, state, type, plan, source, date');
  const p = r.body.people.find((x) => x.id === payer);
  assert(p.planStatus === 'Paying' && p.sourceLabel === 'Settings', 'payer row: Paying, from settings');
  const c = r.body.people.find((x) => x.id === client);
  assert(c.accountTypes.join() === 'client' && c.businessName === null && c.planStatus === '', 'client row: client, no business');

  console.log('\n[3] withdrawing removes them');
  r = await call(prefsHandler, { method: 'PATCH', cookie: cookieFor(payer), body: { marketingEmails: false } });
  assert(r.statusCode === 200, 'payer turns marketing off in settings');
  const res = mkRes();
  await unsubscribeHandler({ method: 'POST', query: { token: mintUnsubscribeToken({ scope: 'user', id: client, type: 'marketing' }) }, headers: {} }, res);
  r = await listQ(TAG);
  const after = new Set(r.body.people.map((x) => x.id));
  assert(!after.has(payer) && !after.has(client) && after.has(owner) && r.body.total === 2, 'settings switch and unsubscribe both remove them');

  console.log('\n[4] search');
  r = await listQ(`olive studio`);
  assert(r.body.people.some((x) => x.id === owner) && !r.body.people.some((x) => x.id === evil), 'search by business name');
  r = await listQ(`%`);
  assert(r.statusCode === 200 && !r.body.people.some((x) => x.id === owner), 'a bare % is a literal, not a wildcard');

  console.log('\n[5] CSV export');
  const before = (await sql`SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'admin.export' AND meta->>'kind' = 'marketing_list'`).rows[0].n;
  r = await call(listHandler, { admin: true, query: { format: 'csv', q: TAG } });
  const csv = r.chunks.join('');
  assert(r.statusCode === 200 && /text\/csv/.test(r.headers['content-type']) && /attachment/.test(r.headers['content-disposition']), 'CSV download headers');
  const lines = csv.trim().split('\n');
  assert(lines[0] === 'Name,Email,Account type,Opted in at,Opted in from,Business,State,Plan status', 'header row');
  assert(lines.length === 3, `two opted-in rows (got ${lines.length - 1})`);
  const evilLine = lines.find((l) => l.includes(em('evil')));
  assert(evilLine && evilLine.startsWith(`"'=HYPERLINK(`) && evilLine.includes(`'+SUM(A1:A2)`), 'formula cells prefixed so spreadsheets show them as text');
  assert(!lines.slice(1).some((l) => /^[=+\-@]/.test(l) || /,[=+\-@]/.test(l)), 'no cell starts with a formula character');
  const afterN = (await sql`SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'admin.export' AND meta->>'kind' = 'marketing_list'`).rows[0].n;
  assert(afterN === before + 1, 'export written to the audit log');
}

run()
  .catch((e) => { fail++; console.error('crashed:', e); })
  .finally(async () => {
    await cleanup().catch(() => {});
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
