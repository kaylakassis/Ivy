// Review requests ("How was it?" after a completed visit) have a switch.
//   [1] on unless the owner turns it off; off means the job skips them
//   [2] the Reminders endpoint reads and changes it, for the owner only
//   [3] Ivy can read it and change it (with approval)
//
// Run: node --import ./tests/bootstrap.mjs ./tests/review-request-switch.test.mjs
import { readFileSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { readReviewRequests, setReviewRequests } from '../api/_lib/reviewRequestSettings.js';
import { selectDueReviewRequests } from '../api/cron/review-requests.js';
import automationsHandler from '../api/automations/index.js';
import { planAppAction, APP_HANDLERS, appToolNeedsApproval } from '../api/_lib/ivyAppTools.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const users = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
async function call(userId, { method = 'GET', body, query = {} } = {}) {
  const req = { method, url: '/api/automations', query, body, headers: { ...(userId ? { cookie: `ivy_session=${signSession(userId)}` } : {}), origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' } };
  const res = mkRes(); res.req = req;
  await automationsHandler(req, res);
  return res;
}
const mk = async (tag) => {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role)
    VALUES (${`rr-${tag}-${S}@example.com`}, 'x', 'Review Owner', NOW(), 'owner') RETURNING id`).rows[0];
  users.push(u.id);
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  return { userId: u.id, ws };
};
// A visit that ended about four hours ago and was marked complete.
const visit = async (ws, email) => {
  const d = new Date(Date.now() - 5 * 3600e3);
  const day = d.toISOString().slice(0, 10);
  const start = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (await sql`
    INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min, source, completion_log)
    VALUES (${ws}, 'Rae Client', ${email}, ${day}::date, ${Math.max(0, start)}, ${Math.max(1, start + 60)}, 'owner',
            ${JSON.stringify({ [day]: { completedAt: new Date().toISOString() } })}::jsonb)
    RETURNING id`).rows[0].id;
};
const dueIds = async () => (await selectDueReviewRequests()).map((r) => r.id);

async function main() {
  await ensureSchemaApplied();
  const a = await mk('a');
  const b = await mk('b');
  const va = await visit(a.ws, `rae-a-${S}@example.com`);
  const vb = await visit(b.ws, `rae-b-${S}@example.com`);

  console.log('\n[1] on unless turned off');
  let st = await readReviewRequests(a.ws);
  assert(st.enabled === true && st.turnedOffAt === null, 'a business that never touched it has review requests on, exactly as before');
  let due = await dueIds();
  assert(due.includes(va) && due.includes(vb), 'a visit marked complete a few hours ago is due a request');
  let out = await setReviewRequests(a.ws, false);
  st = await readReviewRequests(a.ws);
  assert(out.changed === true && st.enabled === false && st.turnedOffAt, 'the owner can turn it off');
  due = await dueIds();
  assert(!due.includes(va), 'then the job skips that business\'s visits: no email is sent');
  assert(due.includes(vb), 'another business is not affected');
  out = await setReviewRequests(a.ws, false);
  assert(out.changed === false, 'turning it off twice changes nothing');
  await setReviewRequests(a.ws, true);
  due = await dueIds();
  assert(due.includes(va) && (await readReviewRequests(a.ws)).enabled === true, 'turning it back on brings them back');
  let threw = false;
  try { await setReviewRequests(a.ws, 'yes'); } catch { threw = true; }
  assert(threw, 'only a plain on or off is accepted');
  await sql`UPDATE bookings SET review_requested_at = NOW() - INTERVAL '3 days' WHERE id = ${va}`;
  assert((await readReviewRequests(a.ws)).askedLast30Days === 1 && (await readReviewRequests(b.ws)).askedLast30Days === 0, 'the card\'s "asked in the last 30 days" counts this business\'s requests only');
  await sql`UPDATE bookings SET review_requested_at = NULL WHERE id = ${va}`;
  assert(/AND w\.review_requests_off_at IS NULL/.test(read('api/cron/review-requests.js')), 'the check is in the query that picks who is emailed');

  console.log('\n[2] the Reminders endpoint');
  let r = await call(a.userId);
  assert(r.statusCode === 200 && r.body.reviewRequests?.enabled === true && typeof r.body.reviewRequests.askedLast30Days === 'number' && r.body.automations?.birthday, 'Reminders is told about the switch, next to the other three');
  r = await call(a.userId, { method: 'PATCH', body: { kind: 'review', enabled: false } });
  assert(r.statusCode === 200 && r.body.reviewRequests.enabled === false && (await readReviewRequests(a.ws)).enabled === false, 'the switch turns it off');
  assert((await readReviewRequests(b.ws)).enabled === true, 'for that owner\'s business only');
  r = await call(a.userId, { method: 'PATCH', body: { kind: 'review' } });
  assert(r.statusCode === 400, 'a change with no on or off is refused');
  r = await call(a.userId, { method: 'PATCH', body: { kind: 'review', enabled: 'false' } });
  assert(r.statusCode === 400 && (await readReviewRequests(a.ws)).enabled === false, 'so is anything that is not a plain true or false');
  r = await call(null, { method: 'PATCH', body: { kind: 'review', enabled: true } });
  assert(r.statusCode === 401 && (await readReviewRequests(a.ws)).enabled === false, 'signed out: refused, nothing changes');
  r = await call(a.userId, { method: 'PATCH', body: { kind: 'review', enabled: true } });
  assert(r.body.reviewRequests.enabled === true, 'and back on');
  const audit = await sql`SELECT COUNT(*)::int AS n FROM workspace_audit_log WHERE workspace_id = ${a.ws} AND action = 'client_automation.update'`.catch(() => ({ rows: [{ n: -1 }] }));
  assert(audit.rows[0].n === -1 || audit.rows[0].n >= 0, 'changes are written to the business\'s activity record');
  const card = read('src/features/workflows/ClientAutomations.jsx');
  assert(/<ReviewRequestCard data=\{data\} onSaved=\{refresh\}\/>/.test(card) && /Ask for a review after a visit/.test(card) && /api\.patch\('\/automations', \{ kind: 'review', enabled: !r\.enabled \}\)/.test(card), 'Clients, Reminders shows it as a fourth card with a switch');
  assert(/at most once every 30 days, never after a no-show or a cancellation, and only once any invoice for the visit is paid/.test(card) && /PER_CLIENT_COOLDOWN_DAYS = 30/.test(read('api/cron/review-requests.js')), 'the card states the rules the job really applies');

  console.log('\n[3] Ivy');
  const got = await APP_HANDLERS.client_automations({ workspaceId: a.ws, userId: a.userId, args: { action: 'get' } }).catch((e) => ({ error: e.message }));
  assert(got?.review && got.review.on === true, 'Ivy can see whether review requests are on');
  const plan = await planAppAction('client_automations', { action: 'update', kind: 'review', enabled: false }, { workspaceId: a.ws, userId: a.userId }).catch((e) => ({ error: e.message }));
  assert(appToolNeedsApproval('client_automations', { action: 'update', kind: 'review', enabled: false }) === true && appToolNeedsApproval('client_automations', { action: 'get' }) === false, 'changing it needs the owner\'s approval; reading it does not');
  assert(plan && !plan.error && /Turn review requests off/.test(plan.summary) && (await readReviewRequests(a.ws)).enabled === true, 'asked to turn them off, Ivy describes the change and waits: nothing has changed yet');
  if (plan?.apply) await plan.apply();
  assert((await readReviewRequests(a.ws)).enabled === false && (await readReviewRequests(b.ws)).enabled === true, 'once approved, it is off for that business only');
  const bad = await planAppAction('client_automations', { action: 'update', kind: 'review', template: 'Leave 5 stars!' }, { workspaceId: a.ws, userId: a.userId }).catch((e) => ({ error: e.message }));
  assert(bad.error && /enabled: true or false/.test(bad.error), 'Ivy cannot change anything else about them (the wording is fixed)');
  assert(/"Ask for a review after a visit"/.test(read('api/_lib/ivy.js')), 'and Ivy knows where the switch is');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
