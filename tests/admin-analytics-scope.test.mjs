// Admin analytics count real customers only. Beta, sponsored, super-admin,
// comped and flagged test accounts are excluded everywhere: totals, funnel,
// platform impact, and the cached rollups the cron writes.
// Run: node --import ./tests/bootstrap.mjs ./tests/admin-analytics-scope.test.mjs
process.env.ADMIN_SECRET ||= 'test-admin-secret';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import analytics from '../api/admin/analytics.js';
import usersList from '../api/admin/users.js';
import userPatch from '../api/admin/users/[id].js';
import refreshCron from '../api/cron/refresh-admin-analytics.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} });
let ipN = 0;
const adminReq = ({ method = 'GET', body = {}, query = {}, url = '/test' } = {}) => { ipN++; return { method, url, query, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-admin-secret': process.env.ADMIN_SECRET, 'x-forwarded-for': `198.51.100.${(ipN % 200) + 10}` } }; };

async function owner(tag, { userType = 'regular', comp = false, compInvite = false, tester = false } = {}) {
  const email = `scope-${tag}-${S}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type, is_tester, last_active_at) VALUES (${email}, 'x', ${tag}, NOW(), ${userType}, ${tester}, NULL) RETURNING id`).rows[0].id;
  const w = (await sql.query(
    `INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at, converted_at, paywall_first_seen_at, comp_until)
     VALUES ($1, $2, 'active', NOW() + INTERVAL '30 days', NOW(), NOW(), NOW(), ${comp ? "NOW() + INTERVAL '365 days'" : 'NULL'}) RETURNING id`, [u, tag])).rows[0].id;
  if (compInvite) await sql`INSERT INTO comp_invites (email, note, comp_months, created_by) VALUES (${email}, 'test', NULL, ${u}) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO bookings (workspace_id, client_name, date, start_min, end_min) VALUES (${w}, 'C', CURRENT_DATE - 2, 540, 600)`;
  await sql`INSERT INTO invoices (workspace_id, client_name, number, status, items, tax_rate, discount, total, paid_amount, paid_at) VALUES (${w}, 'C', ${'INV-' + tag + S}, 'paid', '[{"description":"x","quantity":1,"rate":100}]'::jsonb, 0, 0, 100, 100, NOW())`;
  return { u, w, email };
}

async function main() {
  await ensureSchemaApplied();
  // Clean slate for the cached rollups so the live queries run.
  await sql`DELETE FROM admin_analytics_cache WHERE key IN ('totals', 'platformImpact')`;
  const real = await owner('real');
  const real2 = await owner('real2');
  const beta = await owner('beta', { userType: 'beta' });
  const sponsored = await owner('spons', { userType: 'sponsored' });
  const admin = await owner('admin', { userType: 'super_admin' });
  const comped = await owner('comped', { comp: true });
  const invited = await owner('compinv', { compInvite: true });
  const tester = await owner('tester', { tester: true });

  // Window starts at this run's own start so rows from an earlier run never leak in.
  const from = new Date(S - 1000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const run = async () => { const res = mockRes(); await analytics(adminReq({ query: { from, to } }), res); return res; };

  console.log('\n[1] overview counts only the two real owners');
  let r = await run();
  assert(r.statusCode === 200, `200 (${r.statusCode})`);
  const t = r.body.totals;
  assert(t.newSignups === 2, `new signups in window = 2 (${t.newSignups})`);
  assert(Number(t.revenueWindow) === 200, `window revenue counts $200, the two real invoices (${t.revenueWindow})`);
  const f = r.body.funnel || {};
  assert((f.signups ?? f.signup) === 2, `funnel cohort = 2 (${f.signups ?? f.signup})`);
  assert(t.sponsored === 0, 'sponsored tile is 0 (sponsored accounts are excluded)');

  console.log('\n[2] users list: testers filter vs real filter');
  let res = mockRes(); await usersList(adminReq({ query: { type: 'testers', q: `scope-` } }), res);
  const testers = (res.body.users || []).filter((x) => x.email.includes(`-${S}@`)).map((x) => x.email.split('-')[1]).sort();
  assert(JSON.stringify(testers) === JSON.stringify(['admin', 'beta', 'comped', 'compinv', 'spons', 'tester']), `excluded: ${testers.join(', ')}`);
  res = mockRes(); await usersList(adminReq({ query: { type: 'real', q: `scope-` } }), res);
  const reals = (res.body.users || []).filter((x) => x.email.includes(`-${S}@`)).map((x) => x.email.split('-')[1]).sort();
  assert(JSON.stringify(reals) === JSON.stringify(['real', 'real2']), `real: ${reals.join(', ')}`);
  const row = (res.body.users || []).find((x) => x.email === real.email);
  assert(row && row.excludedFromAnalytics === false && row.isTester === false, 'real row flags');
  res = mockRes(); await usersList(adminReq({ query: { type: 'testers', q: `scope-tester-` } }), res);
  assert(res.body.users[0]?.isTester === true && res.body.users[0]?.excludedFromAnalytics === true, 'flagged tester row flags');

  console.log('\n[3] marking a real account as a test account removes it everywhere');
  res = mockRes(); await userPatch(adminReq({ method: 'PATCH', query: { id: real2.u }, body: { isTester: true } }), res);
  assert(res.statusCode === 200, `PATCH 200 (${res.statusCode} ${JSON.stringify(res.body).slice(0, 100)})`);
  r = await run();
  assert(r.body.totals.newSignups === 1 && (r.body.funnel?.signups ?? r.body.funnel?.signup) === 1, 'now one real signup');
  res = mockRes(); await userPatch(adminReq({ method: 'PATCH', query: { id: real2.u }, body: { isTester: false } }), res);
  r = await run();
  assert(r.body.totals.newSignups === 2, 'unflagging counts it again');

  console.log('\n[4] the cached rollups the cron writes use the same scope');
  process.env.CRON_SECRET = 'cron-scope-test';
  res = mockRes(); await refreshCron({ method: 'GET', headers: { authorization: 'Bearer cron-scope-test' }, query: {} }, res);
  assert(res.statusCode === 200, `cron 200 (${res.statusCode})`);
  const cached = (await sql`SELECT value FROM admin_analytics_cache WHERE key = 'totals'`).rows[0]?.value;
  const realUsers = (await sql`SELECT COUNT(*)::int AS n FROM admin_real_users`).rows[0].n;
  const allUsers = (await sql`SELECT COUNT(*)::int AS n FROM users WHERE deleted_at IS NULL`).rows[0].n;
  assert(cached && cached.users === realUsers && realUsers < allUsers, `cached users = real users (${cached?.users} of ${allUsers} total)`);
  assert(cached.sponsored === 0, 'cached sponsored = 0');
  const platform = (await sql`SELECT value FROM admin_analytics_cache WHERE key = 'platformImpact'`).rows[0]?.value;
  const realBookings = (await sql`SELECT COUNT(*)::int AS n FROM admin_real_bookings WHERE date >= CURRENT_DATE - 90`).rows[0].n;
  assert(platform && platform.bookingsCounted === realBookings, `platform bookings counted = real bookings (${platform?.bookingsCounted} vs ${realBookings})`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
