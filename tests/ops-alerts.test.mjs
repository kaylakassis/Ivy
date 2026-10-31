// Operator alerts: the hourly ops-alerts cron emails the operator once when
// a condition starts, at most every 6 hours while it lasts, and once when it
// clears. Quiet system: no email. Covers Ivy failure bursts, stale or failed
// crons, webhook failures and readiness regressions.
// Run: node --import ./tests/bootstrap.mjs ./tests/ops-alerts.test.mjs
process.env.CRON_SECRET = 'cron-test-secret-at-least-32-chars-long-ok';
process.env.ADMIN_SECRET = 'test-admin-secret-at-least-32-chars-long-please';
process.env.SECRETS_KEY = 'test-secrets-key-at-least-32-chars-long-please';
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.OPS_ALERT_EMAIL = 'ops@example.com';

import fs from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import handler from '../api/cron/ops-alerts.js';
import readinessHandler from '../api/admin/prod-readiness.js';
import { recordWebhookFailure, SIGNATURE_FAILURE } from '../api/_lib/webhookFailures.js';
import { expectedIntervalMs, staleAfterMs, loadCronSchedules, renderOpsAlertEmail } from '../api/_lib/opsAlerts.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Capture outbound provider calls instead of sending.
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('resend.com')) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const mkRes = () => { const r = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { r.headers[k] = v; }, getHeader(k) { return r.headers[k]; }, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; };
const run = async (headers = { authorization: `Bearer ${process.env.CRON_SECRET}` }) => {
  sent.length = 0;
  const res = mkRes();
  await handler({ method: 'GET', headers, query: {}, url: '/api/cron/ops-alerts' }, res);
  return res;
};
const state = async (key) => (await sql`SELECT * FROM ops_alert_state WHERE key = ${key}`).rows[0];
const cronDefs = JSON.parse(fs.readFileSync('vercel.json', 'utf8')).crons
  .map((c) => ({ name: c.path.replace('/api/cron/', ''), schedule: c.schedule })).filter((c) => c.name !== 'ops-alerts');
const crons = cronDefs.map((c) => c.name);
async function seedHealthyCron(name, ago = '1 minute') {
  await sql.query(
    `INSERT INTO cron_runs (name, started_at, finished_at, duration_ms, ok, metrics)
     VALUES ($1, NOW() - $2::interval, NOW() - $2::interval, 100, TRUE, '{}'::jsonb)`,
    [name, ago],
  );
}
async function ivyFailure(message) {
  await sql`INSERT INTO ivy_failures (status, error_name, message) VALUES (529, 'APIError', ${message})`;
}

async function main() {
  await ensureSchemaApplied();
  // Quiet baseline: no alert state, nothing failing in the last hours, every
  // scheduled cron succeeded a minute ago.
  await sql`DELETE FROM ops_alert_state`;
  await sql`DELETE FROM webhook_failures`;
  await sql`DELETE FROM ivy_failures WHERE created_at > NOW() - INTERVAL '2 hours'`;
  await sql`DELETE FROM cron_runs WHERE ok = FALSE OR finished_at IS NULL`;
  for (const name of crons) await seedHealthyCron(name);
  // Every job has existed with its current schedule for a long time, so the
  // staleness rules below apply in full.
  await sql`DELETE FROM cron_schedule_seen`;
  for (const c of cronDefs) {
    await sql`INSERT INTO cron_schedule_seen (name, schedule, first_seen_at) VALUES (${c.name}, ${c.schedule}, NOW() - INTERVAL '100 days')`;
  }

  console.log('\n[0] cadence parsing');
  const H = 3600e3;
  assert(expectedIntervalMs('17 * * * *') === H && staleAfterMs('17 * * * *') === 3 * H, 'hourly cron: overdue after 3 hours');
  assert(expectedIntervalMs('*/10 * * * *') === H && staleAfterMs('*/10 * * * *') === 3 * H, 'every-10-minutes cron: treated as hourly, 3 hours');
  assert(expectedIntervalMs('0 9 * * *') === 24 * H && staleAfterMs('0 9 * * *') === 50 * H, 'daily cron: overdue after 50 hours');
  assert(expectedIntervalMs('0 9,13,17 * * *') === 24 * H, 'several times a day: daily category');
  assert(staleAfterMs('30 4 * * 0') === 2 * 7 * 24 * H + 2 * H, 'weekly cron: 2 weeks plus slack');
  const scheduled = loadCronSchedules();
  assert(scheduled.some((c) => c.name === 'ops-alerts' && c.schedule === '17 * * * *'), 'ops-alerts is scheduled hourly in vercel.json');
  assert(scheduled.length === crons.length + 1, `every vercel.json cron is loaded (${scheduled.length})`);

  console.log('\n[1] auth');
  assert((await run({})).statusCode === 401, 'no secret: 401');
  assert((await run({ authorization: 'Bearer nope' })).statusCode === 401, 'wrong secret: 401');
  assert((await run({ 'x-admin-secret': process.env.ADMIN_SECRET })).statusCode === 200, 'admin secret accepted');

  console.log('\n[2] quiet system: nothing fires, nothing is emailed');
  let r = await run();
  assert(r.statusCode === 200 && r.body.firing === 0 && r.body.emailed === 0, `firing=${r.body.firing} emailed=${r.body.emailed} (${JSON.stringify(r.body.alerts)})`);
  assert(sent.length === 0, 'no email');

  console.log('\n[3] an Ivy failure burst sends exactly one email');
  for (let i = 0; i < 6; i++) await ivyFailure('Overloaded, try again later');
  await ivyFailure('Request timed out');
  r = await run();
  assert(r.body.firing === 1 && r.body.started === 1 && r.body.emailed === 1, `one condition started (${JSON.stringify(r.body)})`);
  assert(sent.length === 1, 'exactly one email');
  const m = sent[0];
  assert(m.to[0] === 'ops@example.com', `to OPS_ALERT_EMAIL (${m.to})`);
  assert(m.subject === '[Ivy alert] Ivy failures: 7 in the last hour', `subject: ${m.subject}`);
  assert(/7 failed replies/.test(m.html) && /Overloaded, try again later/.test(m.html) && /6 times/.test(m.html), 'body has the count and the most common error');
  assert(/Since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/.test(m.html), 'body says since when');
  assert(/Admin → Readiness/.test(m.html) && /admin\?tab=readiness/.test(m.html), 'body points at Admin → Readiness');
  let s = await state('ivy_failures');
  assert(s?.active === true && !!s.last_notified_at && !!s.first_seen_at, 'state row active with notification stamp');

  console.log('\n[4] the next hourly run sends nothing');
  const stamp = s.last_notified_at;
  r = await run();
  assert(r.body.firing === 1 && r.body.started === 0 && r.body.reminded === 0 && r.body.emailed === 0, `still firing, nothing new (${JSON.stringify(r.body)})`);
  assert(sent.length === 0, 'no email');
  s = await state('ivy_failures');
  assert(String(s.last_notified_at) === String(stamp), 'notification stamp unchanged');

  console.log('\n[5] after 6 hours one reminder, then quiet again');
  await sql`UPDATE ops_alert_state SET last_notified_at = NOW() - INTERVAL '7 hours' WHERE key = 'ivy_failures'`;
  r = await run();
  assert(r.body.reminded === 1 && r.body.emailed === 1 && sent.length === 1, 'one reminder email');
  assert(/^\[Ivy alert\] Still active: Ivy failures: 7 in the last hour$/.test(sent[0].subject), `reminder subject: ${sent[0].subject}`);
  r = await run();
  assert(r.body.emailed === 0 && sent.length === 0, 'reminder reset the clock');

  console.log('\n[6] clearing the condition sends one Resolved email');
  await sql`DELETE FROM ivy_failures WHERE created_at > NOW() - INTERVAL '2 hours'`;
  r = await run();
  assert(r.body.firing === 0 && r.body.resolved === 1 && r.body.emailed === 1 && sent.length === 1, `resolved once (${JSON.stringify(r.body)})`);
  assert(sent[0].subject === '[Ivy alert] Resolved: Ivy failures: 7 in the last hour', `subject: ${sent[0].subject}`);
  assert(/cleared/.test(sent[0].html), 'body says it cleared');
  s = await state('ivy_failures');
  assert(s.active === false, 'state row inactive');
  r = await run();
  assert(r.body.emailed === 0 && sent.length === 0, 'and then nothing more');

  console.log('\n[7] stale and failed crons');
  await sql`UPDATE cron_runs SET started_at = NOW() - INTERVAL '2 hours', finished_at = NOW() - INTERVAL '2 hours' WHERE name = 'daily-return'`;
  r = await run();
  assert(r.body.firing === 0, 'hourly cron 2 hours old is still fine');
  await sql`UPDATE cron_runs SET started_at = NOW() - INTERVAL '4 hours', finished_at = NOW() - INTERVAL '4 hours' WHERE name = 'daily-return'`;
  await sql`UPDATE cron_runs SET started_at = NOW() - INTERVAL '60 hours', finished_at = NOW() - INTERVAL '60 hours' WHERE name = 'plan-ending'`;
  await sql`INSERT INTO cron_runs (name, started_at, finished_at, duration_ms, ok, metrics, error_message) VALUES ('db-prune', NOW(), NOW(), 5, FALSE, '{}'::jsonb, 'relation does not exist')`;
  r = await run();
  const keys = r.body.alerts.map((a) => a.key).sort();
  assert(JSON.stringify(keys) === JSON.stringify(['cron:daily-return', 'cron:db-prune', 'cron:plan-ending']), `three cron conditions (${keys})`);
  assert(r.body.emailed === 1 && sent.length === 1, 'batched into one email');
  assert(/^\[Ivy alert\] 3 new conditions: Cron overdue: /.test(sent[0].subject), `subject: ${sent[0].subject}`);
  assert(/Cron overdue: plan-ending/.test(sent[0].html) && /50 hours/.test(sent[0].html), 'daily cron overdue after 50 hours');
  assert(/Cron overdue: daily-return/.test(sent[0].html) && /3 hours/.test(sent[0].html), 'hourly cron overdue after 3 hours');
  assert(/Cron failed: db-prune/.test(sent[0].html) && /relation does not exist/.test(sent[0].html), 'failed last run named with its error');
  assert(/cron-health/.test(sent[0].html), 'points at the cron health report');
  await sql`DELETE FROM cron_runs WHERE ok = FALSE`;
  await seedHealthyCron('plan-ending'); await seedHealthyCron('daily-return'); await seedHealthyCron('db-prune');
  r = await run();
  assert(r.body.firing === 0 && r.body.resolved === 3 && r.body.emailed === 1 && sent.length === 1, 'one Resolved email for all three');
  assert(/^\[Ivy alert\] Resolved: 3 conditions/.test(sent[0].subject), `subject: ${sent[0].subject}`);

  console.log('\n[7b] a brand-new job is not overdue before its first chance to run');
  sent.length = 0;
  await sql`DELETE FROM cron_runs WHERE name = 'plan-ending'`;
  await sql`UPDATE cron_schedule_seen SET first_seen_at = NOW() WHERE name = 'plan-ending'`;
  r = await run();
  assert(!r.body.alerts.some((a) => a.key === 'cron:plan-ending') && sent.length === 0, 'new daily job with no runs yet: no alert');
  await sql`UPDATE cron_schedule_seen SET first_seen_at = NOW() - INTERVAL '60 hours' WHERE name = 'plan-ending'`;
  r = await run();
  assert(r.body.alerts.some((a) => a.key === 'cron:plan-ending') && sent.length === 1 && /never recorded a successful run/.test(sent[0].html), 'still never ran after its full window: alert');
  await seedHealthyCron('plan-ending');
  r = await run();
  assert(r.body.firing === 0, 'first successful run clears it');
  sent.length = 0;

  console.log('\n[7c] a job moved from daily to hourly gets a full hourly window');
  await sql`UPDATE cron_runs SET started_at = NOW() - INTERVAL '8 hours', finished_at = NOW() - INTERVAL '8 hours' WHERE name = 'review-requests'`;
  await sql`UPDATE cron_schedule_seen SET schedule = '0 17 * * *', first_seen_at = NOW() - INTERVAL '100 days' WHERE name = 'review-requests'`;
  r = await run();
  assert(!r.body.alerts.some((a) => a.key === 'cron:review-requests'), 'just rescheduled: last daily run is not judged by the hourly rule');
  const seen = (await sql`SELECT schedule, first_seen_at FROM cron_schedule_seen WHERE name = 'review-requests'`).rows[0];
  assert(seen.schedule !== '0 17 * * *' && Date.now() - new Date(seen.first_seen_at).getTime() < 60_000, 'new schedule recorded with a fresh start time');
  await sql`UPDATE cron_schedule_seen SET first_seen_at = NOW() - INTERVAL '4 hours' WHERE name = 'review-requests'`;
  r = await run();
  assert(r.body.alerts.some((a) => a.key === 'cron:review-requests'), 'after a full hourly window with no run: alert');
  await seedHealthyCron('review-requests');
  r = await run();
  sent.length = 0;

  console.log('\n[8] webhook failures');
  await recordWebhookFailure({ message: new Error('bad key sk_live_abc123') });
  await recordWebhookFailure({ source: 'billing', eventType: 'invoice.payment_failed', message: 'fetchSubscription failed' });
  await recordWebhookFailure({ source: 'billing', eventType: 'invoice.payment_failed', message: 'fetchSubscription failed' });
  await recordWebhookFailure(undefined).catch(() => assert(false, 'helper threw'));
  const stored = (await sql`SELECT source, event_type, message FROM webhook_failures ORDER BY id`).rows;
  assert(stored.length === 4 && stored[0].source === 'unknown' && /\[key\]/.test(stored[0].message) && !/sk_live/.test(stored[0].message), 'rows stored, secrets redacted, empty input tolerated');
  r = await run();
  assert(r.body.alerts.some((a) => a.key === 'webhook_failures' && a.title === 'Webhook failures: 4 in the last hour'), `webhook failures fire at 3 or more (${JSON.stringify(r.body.alerts)})`);
  assert(sent.length === 1 && /billing 2/.test(sent[0].html) && /fetchSubscription failed/.test(sent[0].html), 'email has per-source counts and the common error');
  for (let i = 0; i < 5; i++) await recordWebhookFailure({ source: 'stripe', eventType: SIGNATURE_FAILURE, message: 'No signatures found matching the expected signature' });
  r = await run();
  assert(r.body.alerts.some((a) => a.key === 'webhook_signature') && r.body.started === 1 && sent.length === 1, 'signature burst at 5 is its own condition');
  assert(/Webhook signature failures: 5 in the last hour/.test(sent[0].subject) && /stripe 5/.test(sent[0].html), `subject: ${sent[0].subject}`);
  await sql`DELETE FROM webhook_failures`;
  r = await run();
  assert(r.body.resolved === 2 && sent.length === 1, 'both webhook conditions resolve in one email');

  console.log('\n[9] readiness regression');
  const goodJwt = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'change-me';
  r = await run();
  assert(r.body.alerts.some((a) => a.key === 'readiness:jwt_secret') && sent.length === 1, 'placeholder JWT_SECRET fires');
  assert(sent[0].subject === '[Ivy alert] Readiness: JWT_SECRET is failing', `subject: ${sent[0].subject}`);
  process.env.JWT_SECRET = goodJwt;
  r = await run();
  assert(r.body.resolved === 1 && sent.length === 1 && /Resolved/.test(sent[0].subject), 'restoring it resolves');

  console.log('\n[10] no recipient: state is kept, email retried once an address exists');
  const savedOps = process.env.OPS_ALERT_EMAIL, savedAdmin = process.env.SUPER_ADMIN_EMAIL;
  delete process.env.OPS_ALERT_EMAIL; delete process.env.SUPER_ADMIN_EMAIL;
  for (let i = 0; i < 5; i++) await ivyFailure('Overloaded, try again later');
  r = await run();
  assert(r.body.recipient === false && r.body.started === 1 && r.body.emailed === 0 && sent.length === 0, 'nothing sent without a recipient');
  s = await state('ivy_failures');
  assert(s.active === true && s.last_notified_at === null, 'row active but not yet notified');
  process.env.SUPER_ADMIN_EMAIL = 'admin@example.com';
  r = await run();
  assert(r.body.emailed === 1 && sent.length === 1 && sent[0].to[0] === 'admin@example.com', 'falls back to SUPER_ADMIN_EMAIL and sends the start email');
  process.env.OPS_ALERT_EMAIL = savedOps; if (savedAdmin) process.env.SUPER_ADMIN_EMAIL = savedAdmin; else delete process.env.SUPER_ADMIN_EMAIL;
  await sql`DELETE FROM ivy_failures WHERE created_at > NOW() - INTERVAL '2 hours'`;
  r = await run();
  assert(r.body.resolved === 1 && sent[0].to[0] === 'ops@example.com', 'back to OPS_ALERT_EMAIL');

  console.log('\n[11] Admin → Readiness shows the Operator alerts line');
  const readiness = async () => { const res = mkRes(); await readinessHandler({ method: 'GET', url: '/api/admin/prod-readiness', headers: { 'x-admin-secret': process.env.ADMIN_SECRET } }, res); return res.body.checks.find((c) => c.key === 'ops_alerts'); };
  let line = await readiness();
  assert(line?.level === 'ok' && /ops@example\.com/.test(line.detail) && /No conditions active/.test(line.detail), `ok when recipient set and cron ran (${line?.level}: ${line?.detail})`);
  delete process.env.OPS_ALERT_EMAIL; delete process.env.SUPER_ADMIN_EMAIL;
  line = await readiness();
  assert(line?.level === 'warn' && /OPS_ALERT_EMAIL/.test(line.detail), 'warn without a recipient');
  process.env.OPS_ALERT_EMAIL = savedOps; if (savedAdmin) process.env.SUPER_ADMIN_EMAIL = savedAdmin;
  await sql`UPDATE cron_runs SET finished_at = NOW() - INTERVAL '4 hours' WHERE name = 'ops-alerts'`;
  line = await readiness();
  assert(line?.level === 'warn' && /hours ago/.test(line.detail), 'warn when the cron has not run for 3 hours');
  await sql`UPDATE cron_runs SET finished_at = NOW() WHERE name = 'ops-alerts'`;

  console.log('\n[12] copy');
  const mine = JSON.stringify(sent) + fs.readFileSync('api/_lib/opsAlerts.js', 'utf8') + fs.readFileSync('api/cron/ops-alerts.js', 'utf8') + fs.readFileSync('api/_lib/webhookFailures.js', 'utf8') + fs.readFileSync('docs/ops-alerts.md', 'utf8');
  assert(!/claude|anthropic/i.test(mine + readinessSource()), 'no vendor names anywhere');
  assert(!/\u2014/.test(mine), 'no em dashes in the alert code, emails or docs');
  const e = renderOpsAlertEmail({ kind: 'started', alerts: [{ key: 'k', severity: 'warning', title: 'A <b>title</b>', detail: 'x & y', firstSeenAt: new Date(), where: 'Admin → Readiness' }] });
  assert(/A &lt;b&gt;title&lt;\/b&gt;/.test(e.html) && /x &amp; y/.test(e.html), 'detail is HTML-escaped');
  assert(/business platform/.test(e.html) && !/business OS/i.test(e.html), 'shell says business platform');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
function readinessSource() {
  return fs.readFileSync('api/admin/prod-readiness.js', 'utf8').replace(/process\.env\.[A-Z_]+/g, '');
}
main().catch((e) => { console.error(e); process.exit(1); });
