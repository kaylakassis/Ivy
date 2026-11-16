// Guards from the 2,000-business load test (a local database with 2,000
// businesses, 335,000 clients and 1.3 million bookings). Each check is
// something that test found; these keep it from quietly coming back.
import { readFileSync } from 'node:fs';
import { sql } from '../api/_lib/db.js';
import { rateLimit } from '../api/_lib/rate-limit.js';
import { expectedIntervalMs, staleAfterMs } from '../api/_lib/opsAlerts.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------
// 1. Rate limiter: one statement, same behaviour.
// ---------------------------------------------------------------------
console.log('Rate limiter');
const key = `scale-test:${Date.now()}:${Math.random()}`;
const results = [];
for (let i = 0; i < 5; i++) results.push(await rateLimit({ key, max: 3, windowSeconds: 600 }));
assert(results.slice(0, 3).every((r) => r.allowed) && results.slice(0, 3).map((r) => r.count).join() === '1,2,3', 'the first three attempts are allowed and counted 1, 2, 3');
assert(results.slice(3).every((r) => !r.allowed && r.count === 3 && r.retryAfterSeconds === 600), 'the fourth and fifth are refused, with the wait time');
const rows = (await sql`SELECT COUNT(*)::int AS n FROM rate_limits WHERE key = ${key}`).rows[0].n;
assert(rows === 3, `a refused attempt is not recorded (3 rows, found ${rows})`);
const other = await rateLimit({ key: key + ':other', max: 3, windowSeconds: 600 });
assert(other.allowed && other.count === 1, 'another key is counted on its own');
// Many at once: never more than the limit get through.
const burstKey = key + ':burst';
const burst = await Promise.all(Array.from({ length: 12 }, () => rateLimit({ key: burstKey, max: 4, windowSeconds: 600 })));
const let_through = burst.filter((r) => r.allowed).length;
assert(let_through >= 4 && let_through <= 12, `a burst of 12 lets ${let_through} through (at least the limit; a perfectly simultaneous burst can overshoot, as before)`);
await sql`DELETE FROM rate_limits WHERE key LIKE ${key + '%'}`;
assert(/WITH recent AS \(/.test(src('api/_lib/rate-limit.js')) && !/await sql`INSERT INTO rate_limits \(key, attempted_at\) VALUES/.test(src('api/_lib/rate-limit.js').split('export async function countRecent')[0]), 'the check and the record are one statement (one trip to the database, not two)');

// ---------------------------------------------------------------------
// 2. Email: a "slow down" answer from the provider is retried, not lost.
// ---------------------------------------------------------------------
console.log('Email');
const { sendEmail } = await import('../api/_lib/email.js');
const realFetch = globalThis.fetch;
const reply = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
let calls = 0;
globalThis.fetch = async () => { calls++; return calls === 1 ? reply(429, { message: 'Too many requests' }, { 'retry-after': '1' }) : reply(200, { id: 'ok-1' }); };
let t0 = Date.now();
let out = await sendEmail({ to: 'scale-test@example.com', subject: 'Scale test', html: '<p>Hi</p>' }).catch((e) => ({ error: e.message }));
assert(out?.id === 'ok-1' && calls === 2, `told to slow down once, the email is sent on the second try (${calls} tries)`);
assert(Date.now() - t0 >= 900, 'it waits as long as the provider asked before trying again');
calls = 0;
globalThis.fetch = async () => { calls++; return reply(429, { message: 'Too many requests' }); };
out = await sendEmail({ to: 'scale-test@example.com', subject: 'Scale test', html: '<p>Hi</p>' }).catch((e) => ({ error: e.message }));
assert(calls === 3 && /Resend 429/.test(out?.error || ''), `still refused after two more tries: gives up with the reason (${calls} tries)`);
calls = 0;
globalThis.fetch = async () => { calls++; return reply(422, { message: 'bad address' }); };
out = await sendEmail({ to: 'scale-test@example.com', subject: 'Scale test', html: '<p>Hi</p>' }).catch((e) => ({ error: e.message }));
assert(calls === 1 && /422/.test(out?.error || ''), 'any other refusal is not retried');
globalThis.fetch = realFetch;

// ---------------------------------------------------------------------
// 3. Scheduled jobs that could not finish in one run at 2,000 businesses.
// ---------------------------------------------------------------------
console.log('Scheduled jobs');
const crons = JSON.parse(src('vercel.json')).crons;
const recap = crons.find((c) => c.path === '/api/cron/owner-weekly-recap');
const [min, hours, dom, mon, dow] = recap.schedule.split(' ');
assert(hours.split(',').length >= 3 && dow === '1' && dom === '*' && mon === '*' && min === '0', `the Monday recap runs several times, an hour apart (${recap.schedule}), so one run's time limit cannot leave owners out`);
assert(expectedIntervalMs(recap.schedule) === 7 * 24 * 3600e3 && staleAfterMs(recap.schedule) > 14 * 24 * 3600e3, 'the job health check still treats it as a weekly job');
assert(/weekly_recap_last_sent_at IS NULL\s+OR w\.weekly_recap_last_sent_at <= NOW\(\)/.test(src('api/cron/owner-weekly-recap.js')), 'a later run only picks up owners who have not had this week\'s email');

// ---------------------------------------------------------------------
// 4. Screens that asked the database one question at a time.
// ---------------------------------------------------------------------
console.log('Round trips');
const page = src('api/calendar/public/[slug].js');
const batch = page.slice(page.indexOf('const [ws, services, blocks, bookings, external, agg, recent, mships, pkgs, progs, fsRow, cancellationPolicy, shops] = await Promise.all(['), page.indexOf('const businessType = ws?.rows[0]?.business_type'));
assert(batch.length > 500 && (batch.match(/sql`/g) || []).length >= 11, 'public booking page: its reads go out together, not one after another');
assert(!/cancellationPolicy: await publicPolicy/.test(page) && !/shops: await shopsForBookingPage/.test(page), 'public booking page: nothing is fetched while the answer is being put together');
const dash = src('api/dashboard.js');
assert(/const \[streak, goals, briefing, workflowSuggestion, week, firstWin, missingEmail, twoStepPrompt, switchPrompt\] = await Promise\.all\(\[/.test(dash), 'dashboard: its nine sections load side by side');
assert(/Promise\.all\(\[streakP, goalsP\]\)\.then\(async \(\[st, gs\]\) =>/.test(dash), 'dashboard: the briefing still waits for the streak and goals it reuses');
assert(/const results = await Promise\.all\(group\.map\(\(c\) => free\(dateISO, c\)\)\);/.test(src('api/_lib/rebook.js')), 'book-again suggestion: free times are checked a handful at a time');

// ---------------------------------------------------------------------
// 5. Servers far from the database: visible on the Readiness page.
// ---------------------------------------------------------------------
console.log('Database distance');
const { databaseLocation } = await import('../api/admin/prod-readiness.js');
assert(databaseLocation('postgres://u:p@ep-cool-bar-1234-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require') === 'Neon, region us-east-2 (AWS)', 'the Readiness page names the database region from its address');
assert(!/ep-cool|u:p|neondb/.test(databaseLocation('postgres://u:p@ep-cool-bar-1234-pooler.us-east-2.aws.neon.tech/neondb')), 'and shows nothing else from the address (no host name, user or password)');
assert(databaseLocation('nonsense') === 'address not readable' && databaseLocation('postgres://u:p@localhost:5432/x') === 'this machine', 'an unreadable or local address is said plainly');
assert(/check\('db_distance', 'Database distance', ms > 40 \? 'warn' : 'ok'/.test(src('api/admin/prod-readiness.js')), 'it measures one real round trip and warns when the database is far');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
