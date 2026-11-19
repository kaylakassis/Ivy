// Unusual-activity watch (api/_lib/activityWatch.js):
//   [1] what is counted for a signed-in account, and what is not
//   [2] the first line flags, the second line slows; saving is never touched
//   [3] operators and "view as" are never counted
//   [4] Admin: the list, looks fine / lift / trust, admins only
//   [5] visitors with no account: many different businesses from one network
//   [6] it is wired into the sign-in check and the public pages
//
// Run: node --import ./tests/bootstrap.mjs ./tests/activity-watch.test.mjs
import { readFileSync } from 'node:fs';
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.SUPER_ADMIN_EMAIL = `watch-ops-${Date.now()}@example.com`;
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_watch';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession, requireUser } from '../api/_lib/auth.js';
import {
  watchRead, watchVisit, refuseIfSlowed, guardVisit, listActivityFlags, reviewActivityFlag, describeFlag, ipSubject,
  LIMITS, SLOW_CODE, SLOW_MESSAGE, SLOW_VISITOR_MESSAGE, _setLimitsForTests, _resetForTests, _settleForTests,
} from '../api/_lib/activityWatch.js';
import riskHandler from '../api/admin/risk.js';
import sitePublic from '../api/website/public/[handle].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = 'www.joinivy.ai';
const users = [];
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  if (/api\.resend\.com/.test(String(url))) { try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); } return json({ id: `em_${emails.length}` }); }
  return json({});
};

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
const get = (url, extra = {}) => ({ method: 'GET', url, query: {}, headers: { host: HOST, origin: `https://${HOST}`, ...extra } });
const mkUser = async (tag, type = null) => {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type, signup_role)
    VALUES (${`watch-${tag}-${S}@example.com`}, 'x', ${`Watch ${tag}`}, NOW(), ${type || 'regular'}, 'owner') RETURNING id, email, name, user_type`).rows[0];
  users.push(u.id);
  return u;
};
const readsOf = async (subject) => Number((await sql`SELECT COALESCE(SUM(n), 0)::int AS n FROM activity_reads WHERE subject = ${subject}`).rows[0].n);
const flagOf = async (subject) => (await sql`SELECT * FROM activity_flags WHERE subject = ${subject} ORDER BY first_at DESC LIMIT 1`).rows[0] || null;
// n different addresses, as a script walking pages would ask for.
async function walk(user, n, from = 0, prefix = '/api/clients?cursor=') {
  let limited = 0;
  for (let i = from; i < from + n; i++) { if ((await watchRead(get(`${prefix}${i}`), user)).limited) limited++; }
  await _settleForTests();
  return limited;
}

async function main() {
  await ensureSchemaApplied();
  await sql`DELETE FROM rate_limits WHERE key LIKE 'slow:%'`;

  console.log('\n[1] what is counted');
  _resetForTests();
  const a = await mkUser('a');
  const subjA = `u:${a.id}`;
  for (let i = 0; i < 40; i++) await watchRead(get('/api/notifications?unread=1'), a);
  await _settleForTests();
  assert(await readsOf(subjA) === 1, 'the app refreshing the same thing 40 times counts once');
  await walk(a, 12);
  assert(await readsOf(subjA) === 13, '12 different pages count as 12');
  for (let i = 0; i < 30; i++) await watchRead({ ...get(`/api/clients/${i}`), method: i % 2 ? 'POST' : 'PATCH' }, a);
  await _settleForTests();
  assert(await readsOf(subjA) === 13, 'saving, booking and sending are never counted');
  assert(!(await flagOf(subjA)), 'normal use raises no flag');
  assert(LIMITS.readsFlagHour >= 2000 && LIMITS.readsSlowHour >= 2 * LIMITS.readsFlagHour && LIMITS.readsSlowPerMinute >= 20,
    `the real lines are far above normal use (flag ${LIMITS.readsFlagHour}/hour, slow ${LIMITS.readsSlowHour}/hour)`);

  console.log('\n[2] flag first, then slow down');
  _resetForTests();
  _setLimitsForTests({ readsFlagHour: 20, readsSlowHour: 50, readsSlowPerMinute: 3 });
  const b = await mkUser('b');
  const subjB = `u:${b.id}`;
  let limited = await walk(b, 25);
  let f = await flagOf(subjB);
  assert(limited === 0 && f && f.kind === 'reads' && !f.slow_until && f.user_id === b.id, 'past the first line: flagged, nothing changed for the account');
  await settle();
  assert(emails.length === 1 && /unusual activity/i.test(emails[0].subject) && emails[0].to?.[0] === process.env.SUPER_ADMIN_EMAIL
    && /Watch b/.test(emails[0].html) && /Nothing has been changed/.test(emails[0].html), 'the operator gets one email saying who and what');
  await walk(b, 10, 100);
  await settle();
  assert(emails.length === 1, 'more of the same sends no second email');
  limited = await walk(b, 30, 200);
  f = await flagOf(subjB);
  assert(f.slow_until && new Date(f.slow_until) > new Date() && f.slowed_at, 'past the second line: slowed for an hour');
  await settle();
  assert(emails.length === 2 && /slowed down/i.test(emails[1].subject) && /not affected/.test(emails[1].html), 'and the operator is told it was slowed');
  await sql`DELETE FROM rate_limits WHERE key = ${`slow:${subjB}`}`;
  const verdicts = [];
  for (let i = 0; i < 8; i++) verdicts.push(await watchRead(get(`/api/invoices?cursor=${1000 + i}`), b));
  assert(verdicts.slice(0, 3).every((v) => !v.limited) && verdicts.slice(3).every((v) => v.limited), 'while slowed: 3 new pages a minute get through, the rest wait');
  assert(!(await watchRead(get('/api/invoices?cursor=1000'), b)).limited, 'a screen it already has open keeps refreshing');
  assert(!(await watchRead({ ...get('/api/invoices'), method: 'POST' }, b)).limited, 'saving and charging still work');
  const res429 = mkRes();
  assert(refuseIfSlowed(res429, verdicts[7]) === true && res429.statusCode === 429 && res429.body.code === SLOW_CODE
    && res429.body.error === SLOW_MESSAGE && res429.headers['retry-after'], 'the refusal is a plain message with a wait time');
  assert(!/[–—]/.test(SLOW_MESSAGE + SLOW_VISITOR_MESSAGE) && /hello@joinivy\.ai/.test(SLOW_MESSAGE), 'in plain words, with who to email');
  const before = await readsOf(subjB);
  await _settleForTests();
  assert(await readsOf(subjB) - before <= 4, 'refused reads are not added to the count');

  console.log('\n[3] through the real sign-in check');
  const cookie = `ivy_session=${signSession(b.id)}`;
  await sql`DELETE FROM rate_limits WHERE key = ${`slow:${subjB}`}`;
  const outcomes = [];
  for (let i = 0; i < 6; i++) {
    const res = mkRes();
    const u = await requireUser(get(`/api/calendar?from=${2000 + i}`, { cookie }), res);
    outcomes.push(u ? 'ok' : res.statusCode);
  }
  assert(outcomes.slice(0, 3).every((x) => x === 'ok') && outcomes.slice(3).every((x) => x === 429), `a slowed account is held at the door (${outcomes.join(',')})`);
  const resPost = mkRes();
  assert(!!(await requireUser({ ...get('/api/bookings', { cookie }), method: 'POST' }, resPost)), 'but a save from the same account goes straight through');

  const admin = await mkUser('admin', 'super_admin');
  _setLimitsForTests({ readsFlagHour: 5, readsSlowHour: 10, readsSlowPerMinute: 1 });
  assert(await walk(admin, 40) === 0 && await readsOf(`u:${admin.id}`) === 0 && !(await flagOf(`u:${admin.id}`)), 'an operator is never counted or slowed');
  const c = await mkUser('c');
  for (let i = 0; i < 40; i++) await watchRead(get(`/api/clients?cursor=${i}`, { cookie: 'ivy_session=x; ivy_admin_session=y' }), c);
  await _settleForTests();
  assert(await readsOf(`u:${c.id}`) === 0, 'an operator viewing as a user does not count against that user');
  assert(!(await watchRead(null, null)).limited && !(await watchRead({ method: 'GET' }, {})).limited, 'a malformed call lets the request through');

  console.log('\n[4] Admin');
  let list = await listActivityFlags();
  const row = list.find((x) => x.userId === b.id);
  assert(row && row.slowed && row.accountKind && /different pages of data/.test(row.what) && row.email === b.email, 'the flag is listed with who, what and that it is slowed');
  assert(!/[–—]/.test(describeFlag({ kind: 'reads', peakHour: 6000, dayTotal: 9000 }) + describeFlag({ kind: 'visits', peakHour: 300 }) + describeFlag({ kind: 'reads', peakHour: 100, dayTotal: 12000 })), 'the descriptions are plain words');
  const call = async (userId, method, body) => {
    const res = mkRes();
    await riskHandler({ method, url: '/api/admin/risk', query: {}, body, headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json', cookie: userId ? `ivy_session=${signSession(userId)}` : '' } }, res);
    return res;
  };
  let r = await call(c.id, 'GET');
  assert(r.statusCode === 401 || r.statusCode === 403 || r.statusCode === 404, `a normal account cannot open the list (${r.statusCode})`);
  r = await call(b.id, 'POST', { action: 'activity', flagId: row.id, what: 'trust' });
  assert(r.statusCode !== 200 && (await flagOf(subjB)).slow_until, 'or lift its own slow-down');
  await sql`UPDATE users SET email = ${process.env.SUPER_ADMIN_EMAIL} WHERE id = ${admin.id}`;
  r = await call(admin.id, 'GET');
  assert(r.statusCode === 200 && Array.isArray(r.body.activity) && r.body.activity.some((x) => x.id === row.id), 'the operator sees it in Admin > Risk');
  r = await call(admin.id, 'POST', { action: 'activity', flagId: row.id, what: 'lift' });
  f = await flagOf(subjB);
  assert(r.statusCode === 200 && !f.slow_until && f.reviewed_at, '"Lift the slow-down" ends it and files the flag');
  assert(!(await watchRead(get('/api/invoices?cursor=9001'), b)).limited && !(await watchRead(get('/api/invoices?cursor=9002'), b)).limited, 'the account is back to normal at once');
  assert(!(await listActivityFlags()).some((x) => x.id === row.id), 'and it leaves the list');
  // slow it again, then trust it
  _setLimitsForTests({ readsFlagHour: 20, readsSlowHour: 50, readsSlowPerMinute: 3 });
  await sql`UPDATE activity_flags SET slow_until = NOW() + INTERVAL '30 minutes', reviewed_at = NULL WHERE subject = ${subjB}`;
  _resetForTests(); _setLimitsForTests({ readsFlagHour: 20, readsSlowHour: 50, readsSlowPerMinute: 3 });
  await walk(b, 2, 5000);
  r = await call(admin.id, 'POST', { action: 'activity', flagId: row.id, what: 'trust' });
  const trust = (await sql`SELECT until, by_email FROM activity_trust WHERE subject = ${subjB}`).rows[0];
  assert(r.statusCode === 200 && trust && new Date(trust.until) > new Date(Date.now() + 29 * 86400e3) && trust.by_email === process.env.SUPER_ADMIN_EMAIL, '"Trust this account" is recorded with who said so, for 30 days');
  limited = await walk(b, 80, 6000);
  assert(limited === 0, 'a trusted account is not slowed however much it reads');
  const audit = (await sql`SELECT action FROM audit_events WHERE action LIKE 'risk.activity.%' ORDER BY created_at DESC LIMIT 5`.catch(() => ({ rows: [] }))).rows.map((x) => x.action);
  assert(audit.includes('risk.activity.trust') && audit.includes('risk.activity.lift'), `both actions are in the audit log (${audit.join(', ')})`);
  r = await call(admin.id, 'POST', { action: 'activity', flagId: 'nope', what: 'trust' });
  assert(r.statusCode === 400, 'a bad request is refused');

  console.log('\n[5] visitors with no account');
  _resetForTests();
  _setLimitsForTests({ visitsFlagHour: 10, visitsSlowHour: 25, visitsSlowPerMinute: 2 });
  const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
  const from = (addr, ua = 'Mozilla/5.0') => ({ ...get('/api/calendar/public/x'), headers: { host: HOST, 'x-real-ip': addr, 'user-agent': ua } });
  const subjIp = ipSubject(ip);
  await sql`DELETE FROM activity_reads WHERE subject = ${subjIp}`; await sql`DELETE FROM activity_flags WHERE subject = ${subjIp}`;
  await sql`DELETE FROM rate_limits WHERE key = ${`slow:${subjIp}`}`;
  for (let i = 0; i < 30; i++) await watchVisit(from(ip), 'same-business');
  await _settleForTests();
  assert(await readsOf(subjIp) === 1 && !subjIp.includes(ip), 'one business opened 30 times is one; the counter does not store the address itself');
  for (let i = 0; i < 12; i++) await watchVisit(from(ip), `biz-${i}`);
  await _settleForTests();
  f = await flagOf(subjIp);
  assert(f && f.kind === 'visits' && !f.slow_until && f.detail.ip === ip && !f.user_id, 'a dozen different businesses from one network is flagged, with the address for the operator');
  for (let i = 0; i < 20; i++) await watchVisit(from(ip), `more-${i}`);
  await _settleForTests();
  f = await flagOf(subjIp);
  assert(f.slow_until, 'past the second line the network is slowed');
  await sql`DELETE FROM rate_limits WHERE key = ${`slow:${subjIp}`}`;
  const vv = [];
  for (let i = 0; i < 5; i++) vv.push((await watchVisit(from(ip), `new-${i}`)).limited);
  assert(vv.join() === 'false,false,true,true,true', 'only a couple of NEW businesses a minute get through');
  assert(!(await watchVisit(from(ip), 'biz-3')).limited, 'a business it already opened still loads (a real client mid-booking is fine)');
  assert(!(await watchVisit(from('198.51.100.7'), 'new-4')).limited, 'other networks are untouched');
  const before5 = await readsOf(ipSubject('198.51.100.9'));
  for (let i = 0; i < 40; i++) await watchVisit(from('198.51.100.9', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), `g-${i}`);
  await _settleForTests();
  assert(await readsOf(ipSubject('198.51.100.9')) === before5, 'search engines are not counted (owners want to be found)');
  const htmlRes = mkRes();
  const sent = await guardVisit(from(ip), htmlRes, 'new-99', { html: true });
  assert(sent && htmlRes.statusCode === 429 && htmlRes.body === SLOW_VISITOR_MESSAGE, 'a slowed visitor gets a plain "try again in a few minutes"');
  list = await listActivityFlags();
  const vrow = list.find((x) => x.networkAddress === ip);
  assert(vrow && vrow.accountKind === 'Visitor' && /different businesses/.test(vrow.what) && vrow.slowed, 'and shows up in Admin as a visitor');

  console.log('\n[6] through a real public page: trying made-up names');
  _resetForTests();
  _setLimitsForTests({ visitsFlagHour: 6, visitsSlowHour: 12, visitsSlowPerMinute: 2 });
  const ip2 = `203.0.113.${Math.floor(Math.random() * 50) + 201}`;
  await sql`DELETE FROM activity_reads WHERE subject = ${ipSubject(ip2)}`; await sql`DELETE FROM activity_flags WHERE subject = ${ipSubject(ip2)}`;
  await sql`DELETE FROM rate_limits WHERE key IN (${`slow:${ipSubject(ip2)}`}, ${`siteget:ip:${ip2}`})`;
  const codes = [];
  for (let i = 0; i < 22; i++) {
    const res = mkRes();
    await sitePublic({ method: 'GET', url: `/api/website/public/nope-${S}-${i}`, query: { handle: `nope-${S}-${i}` }, headers: { host: HOST, 'x-real-ip': ip2, 'user-agent': 'curl/8' } }, res);
    codes.push(res.statusCode);
    if (i % 5 === 4) await _settleForTests();
  }
  assert(codes.slice(0, 10).every((x) => x === 404) && codes.slice(-4).every((x) => x === 429), `walking through names: "not found" at first, then refused (${codes.join(',')})`);

  console.log('\n[7] wiring');
  const auth = readFileSync(new URL('../api/_lib/auth.js', import.meta.url), 'utf8');
  assert(/if \(refuseIfSlowed\(res, await watchRead\(req, row\)\)\) return null;/.test(auth), 'every signed-in request passes the watch');
  const guarded = ['api/calendar/public/[slug].js', 'api/website/public/[handle].js', 'api/site/[handle]/index.js', 'api/site/[handle]/[slug].js',
    'api/site/[handle]/products.js', 'api/shop/[slug]/index.js', 'api/shop/[slug]/data.js', 'api/businesses/[slug]/index.js'];
  const missing = guarded.filter((p) => !/guardVisit\(req, res,/.test(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')));
  assert(missing.length === 0, `every public business page counts the visit (${missing.join(', ') || 'all 8'})`);
  const prune = readFileSync(new URL('../api/cron/db-prune.js', import.meta.url), 'utf8');
  assert(/prune\('activity_reads'/.test(prune) && /prune\('activity_flags',\s*`first_at < NOW\(\) - INTERVAL '30 days'`/.test(prune), 'old counters and flags are cleared out (flags within 30 days)');
  const tab = readFileSync(new URL('../src/features/admin/RiskTab.jsx', import.meta.url), 'utf8');
  assert(/title="Unusual activity"/.test(tab) && /Lift the slow-down/.test(tab) && /Trust this account for 30 days/.test(tab) && /Looks fine, hide this/.test(tab), 'Admin > Risk has the section and its three actions');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  _resetForTests();
  for (const id of users) {
    await sql`DELETE FROM activity_reads WHERE subject = ${`u:${id}`}`.catch(() => {});
    await sql`DELETE FROM activity_flags WHERE subject = ${`u:${id}`}`.catch(() => {});
    await sql`DELETE FROM activity_trust WHERE subject = ${`u:${id}`}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
  await sql`DELETE FROM activity_flags WHERE kind = 'visits' AND detail->>'ip' LIKE '203.0.113.%'`.catch(() => {});
  await sql`DELETE FROM rate_limits WHERE key LIKE 'slow:%'`.catch(() => {});
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
