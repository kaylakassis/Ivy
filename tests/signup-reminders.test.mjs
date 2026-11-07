// "Finish signing up" reminder cron (api/cron/signup-reminders.js).
//
//   [1] timing: nothing before 3 hours; email 1 at 3 hours; email 2 at
//       24 hours (and not within 23 hours of email 1); email 3 at 3 days;
//       then nothing more
//   [2] who: clients, helpers, testers, beta / sponsored, comped and
//       paying / trialing / previously trialed owners are never emailed;
//       a trial used by the same address on an earlier account counts
//   [3] stops after trial start, after subscribing, after unsubscribe
//       (one-click), after account deletion
//   [4] two runs at once never double send
//   [5] email: List-Unsubscribe + one-click, the right button link
//       (onboarding vs app), no em or en dashes, never "business OS"
//   [6] setup nudge skips someone reminded in the last day
//   [7] admin profile: "sent N of 3" and consent status
//   [8] cron auth
//
// Time is faked by moving users.created_at / signup_reminder_last_sent_at
// back instead of waiting.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/signup-reminders.test.mjs
process.env.CRON_SECRET ||= 'test-cron';
process.env.ADMIN_SECRET ||= 'test-admin-secret';
process.env.APP_URL = 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { trialEmailKey } from '../api/_lib/billingGuard.js';
import { renderSignupReminder, claimReminder } from '../api/_lib/signupReminders.js';
import unsubscribeHandler from '../api/unsubscribe.js';

const { default: cron } = await import('../api/cron/signup-reminders.js');
const { default: setupNudge } = await import('../api/cron/setup-nudge.js');
const { default: adminProfile } = await import('../api/admin/users/[id]/profile.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const sent = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('resend.com')) {
    // A little latency so two overlapping runs really interleave.
    await new Promise((r) => setTimeout(r, 5));
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const toOf = (m) => (Array.isArray(m.to) ? m.to : [m.to]).map((x) => String(x).toLowerCase());
const mailsTo = (addr) => sent.filter((m) => toOf(m).includes(addr.toLowerCase()));

const TAG = `sr${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const em = (t) => `sr-${t}-${TAG}@example.com`;
const mkRes = () => ({
  statusCode: 200, headers: {}, body: null,
  status(c) { this.statusCode = c; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  getHeader(k) { return this.headers[k.toLowerCase()]; },
  json(o) { this.body = o; return this; }, send(o) { this.body = o; return this; },
  end(s) { if (s !== undefined) this.body = s; return this; },
});
const cronReq = (auth = true) => ({ method: 'GET', url: '/api/cron/signup-reminders', query: {},
  headers: auth ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {} });
const runCron = async () => { const r = mkRes(); await cron(cronReq(), r); return r; };

// An owner who signed up `hours` ago. ws: workspace column overrides.
async function owner(tag, { hours = 4, ws = {}, user = {}, onboarded = false, workspace = true } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, created_at, user_type, is_tester)
    VALUES (${em(tag)}, 'x', ${`${tag} Person`}, NOW() - ${`${hours} hours`}::interval,
            ${user.user_type || 'regular'}, ${!!user.is_tester})
    RETURNING id`).rows[0].id;
  let wsId = null;
  if (workspace) {
    wsId = (await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, onboarded_at)
      VALUES (${u}, 'incomplete', NULL, ${onboarded ? new Date().toISOString() : null}) RETURNING id`).rows[0].id;
    for (const [k, v] of Object.entries(ws)) {
      await sql.query(`UPDATE workspaces SET ${k} = $1 WHERE id = $2`, [v, wsId]);
    }
  }
  return { id: u, ws: wsId, email: em(tag) };
}
const step = async (id) => (await sql`SELECT signup_reminder_step FROM users WHERE id = ${id}`).rows[0].signup_reminder_step;
const age = async (id, hours) => sql`UPDATE users SET created_at = NOW() - ${`${hours} hours`}::interval WHERE id = ${id}`;
const lastSentAgo = async (id, hours) => sql`UPDATE users SET signup_reminder_last_sent_at = NOW() - ${`${hours} hours`}::interval WHERE id = ${id}`;
const DASHES = /[–—]/;

async function cleanup() {
  const { rows } = await sql.query(`SELECT id FROM users WHERE email LIKE $1`, [`%${TAG}%`]);
  for (const r of rows) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${r.id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${r.id}`.catch(() => {});
  }
  await sql.query(`DELETE FROM billing_trial_claims WHERE source = $1`, [`test-${TAG}`]).catch(() => {});
}

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] timing: 3 hours, 24 hours, 3 days, then stop');
  const fresh = await owner('fresh', { hours: 2 });
  const A = await owner('timing', { hours: 2 });
  let r = await runCron();
  assert(r.statusCode === 200, `cron 200 (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  assert(mailsTo(A.email).length === 0 && await step(A.id) === 0, 'nothing at 2 hours');
  await age(A.id, 3.1);
  await runCron();
  assert(mailsTo(A.email).length === 1 && await step(A.id) === 1, 'email 1 at 3 hours');
  assert(mailsTo(A.email)[0].subject === "Looks like you didn't finish signing up", 'email 1 subject');
  await runCron();
  assert(mailsTo(A.email).length === 1, 'running again the same hour sends nothing more');
  await age(A.id, 24.5);
  await lastSentAgo(A.id, 10);
  await runCron();
  assert(mailsTo(A.email).length === 1, 'not twice in one day: email 2 waits for 23 hours after email 1');
  await lastSentAgo(A.id, 23.5);
  await runCron();
  assert(mailsTo(A.email).length === 2 && await step(A.id) === 2, 'email 2 at about 24 hours');
  assert(mailsTo(A.email)[1].subject === 'Your Ivy account is still waiting for you', 'email 2 subject');
  await age(A.id, 50);
  await lastSentAgo(A.id, 25);
  await runCron();
  assert(mailsTo(A.email).length === 2, 'email 3 not before 3 days');
  await age(A.id, 72.5);
  await runCron();
  assert(mailsTo(A.email).length === 3 && await step(A.id) === 3, 'email 3 at 3 days');
  assert(mailsTo(A.email)[2].subject === 'Still thinking about Ivy?', 'email 3 subject');
  await age(A.id, 200);
  await lastSentAgo(A.id, 100);
  await runCron();
  assert(mailsTo(A.email).length === 3, 'then stops for good');
  assert(mailsTo(fresh.email).length === 0, 'a 2-hour-old sign-up is untouched');

  console.log('\n[2] who is never emailed');
  const client = await owner('client', { workspace: false });
  const helper = await owner('helper', { workspace: false });
  const tester = await owner('tester', { user: { is_tester: true } });
  const beta = await owner('beta', { user: { user_type: 'beta' } });
  const spons = await owner('spons', { user: { user_type: 'sponsored' } });
  const comped = await owner('comped', { ws: { comp_until: '9999-01-01T00:00:00Z' } });
  // A comp invite on file but not yet applied to the workspace: the invite
  // is claimed only once the email is confirmed, so an unconfirmed invitee
  // (like this one) has no comp_until yet. Still never reminded.
  const invited = await owner('invited');
  await sql`INSERT INTO comp_invites (email, note, comp_months) VALUES (${invited.email.toUpperCase()}, 'test', 3)`;
  const paying = await owner('paying', { ws: { subscription_status: 'active', subscription_period_end: new Date(Date.now() + 30 * 864e5).toISOString() } });
  const trialing = await owner('trialing', { ws: { subscription_status: 'trialing', trial_ends_at: new Date(Date.now() + 10 * 864e5).toISOString() } });
  const lapsed = await owner('lapsed', { ws: { subscription_status: 'canceled', converted_at: new Date(Date.now() - 864e5).toISOString() } });
  const usedTrial = await owner('usedtrial');
  await sql`INSERT INTO billing_trial_claims (email_hash, workspace_id, source) VALUES (${trialEmailKey(usedTrial.email)}, NULL, ${`test-${TAG}`})`;
  const oldAcct = await owner('old', { hours: 24 * 30 });
  // The helper works at the paying owner's business.
  await sql`INSERT INTO staff_members (workspace_id, name, email, active, user_id) VALUES (${paying.ws}, 'H', ${helper.email}, TRUE, ${helper.id})`;
  await runCron();
  for (const [label, p] of [['client', client], ['helper', helper], ['tester', tester], ['beta', beta], ['sponsored', spons],
    ['comped', comped], ['comp invite on file', invited], ['paying', paying], ['trialing', trialing], ['lapsed plan', lapsed],
    ['trial used on an earlier account', usedTrial], ['signed up 30 days ago', oldAcct]]) {
    assert(mailsTo(p.email).length === 0, `${label}: not emailed`);
  }

  console.log('\n[3] stops after trial start, subscribe, unsubscribe, deletion');
  const T = await owner('starttrial', { hours: 4 });
  const P = await owner('subscribes', { hours: 4 });
  const U = await owner('unsubs', { hours: 4 });
  const D = await owner('deletes', { hours: 4 });
  await runCron();
  assert([T, P, U, D].every((p) => mailsTo(p.email).length === 1), 'each got email 1');
  await sql`UPDATE workspaces SET subscription_status = 'trialing', trial_started_at = NOW(), trial_ends_at = NOW() + INTERVAL '14 days' WHERE id = ${T.ws}`;
  await sql`UPDATE workspaces SET subscription_status = 'active', stripe_subscription_id = ${`sub_${TAG}`}, converted_at = NOW() WHERE id = ${P.ws}`;
  const tok = mailsTo(U.email)[0].headers['List-Unsubscribe'].match(/token=([A-Za-z0-9_\-.]+)/)[1];
  const ures = mkRes();
  await unsubscribeHandler({ method: 'POST', query: { token: tok }, headers: {} }, ures);
  assert(ures.statusCode === 200 && ures.body?.ok === true, 'one-click unsubscribe accepted');
  await sql`UPDATE users SET deleted_at = NOW() WHERE id = ${D.id}`;
  for (const p of [T, P, U, D]) { await age(p.id, 30); await lastSentAgo(p.id, 26); }
  await runCron();
  assert(mailsTo(T.email).length === 1, 'started a trial: no more');
  assert(mailsTo(P.email).length === 1, 'subscribed: no more');
  assert(mailsTo(U.email).length === 1, 'unsubscribed: no more');
  assert(mailsTo(D.email).length === 1, 'deleted account: no more');
  const prefs = (await sql`SELECT notification_prefs FROM users WHERE id = ${U.id}`).rows[0].notification_prefs;
  assert(prefs?.email_signup_reminders === false, 'unsubscribe stored as the signup_reminders category');

  console.log('\n[4] two runs at once never double send');
  const par = [];
  for (let i = 0; i < 6; i++) par.push(await owner(`par${i}`, { hours: 5 }));
  const [r1, r2] = await Promise.all([runCron(), runCron()]);
  assert(r1.statusCode === 200 && r2.statusCode === 200, 'both runs finished');
  assert(par.every((p) => mailsTo(p.email).length === 1), 'each person got exactly one email');
  assert((await Promise.all(par.map((p) => step(p.id)))).every((s) => s === 1), 'each step recorded once');
  const C = await owner('claim', { hours: 5 });
  const claims = await Promise.all([claimReminder(C.id, 0), claimReminder(C.id, 0), claimReminder(C.id, 0)]);
  assert(claims.filter((c) => c === 1).length === 1 && claims.filter((c) => c === null).length === 2, 'three racing claims for the same step: exactly one wins');

  console.log('\n[5] the email itself');
  const m = mailsTo(A.email)[0];
  assert(/\/api\/unsubscribe\?token=/.test(m.headers['List-Unsubscribe'] || '') && m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click',
    'List-Unsubscribe with one-click');
  assert(m.html.includes('https://www.joinivy.ai/onboarding'), 'onboarding not done: button goes to /onboarding');
  const onb = await owner('onboarded', { hours: 4, onboarded: true });
  await runCron();
  const mo = mailsTo(onb.email)[0];
  assert(mo && mo.html.includes('href="https://www.joinivy.ai/"') && !mo.html.includes('/onboarding'), 'onboarding done: button goes to the app (plan and trial screen)');
  assert(/free trial/.test(mo.html), 'onboarded variant mentions the free trial');
  for (const s of [1, 2, 3]) {
    for (const onboarded of [false, true]) {
      const e = renderSignupReminder({ step: s, firstName: '<b>Kay</b> Lee', onboarded });
      assert(!DASHES.test(e.subject + e.html), `email ${s}${onboarded ? ' (onboarded)' : ''}: no em or en dashes`);
      assert(!/business os/i.test(e.html) && e.html.includes('Finish setting up') && e.html.includes('&lt;b&gt;Kay&lt;/b&gt;'),
        `email ${s}${onboarded ? ' (onboarded)' : ''}: button, escaped name, no "business OS"`);
    }
  }

  console.log('\n[6] setup nudge skips someone reminded in the last day');
  const N = await owner('nudge', { hours: 24 * 5 });
  await sql`UPDATE workspaces SET subscription_status = 'trialing', trial_ends_at = NOW() + INTERVAL '10 days', onboarded_at = NOW() - INTERVAL '3 days' WHERE id = ${N.ws}`;
  await sql`UPDATE users SET signup_reminder_step = 1, signup_reminder_last_sent_at = NOW() - INTERVAL '2 hours' WHERE id = ${N.id}`;
  const before = mailsTo(N.email).length;
  let nres = mkRes();
  await setupNudge({ method: 'POST', url: '/api/cron/setup-nudge', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, nres);
  let nudged = (await sql`SELECT setup_nudge_sent_at FROM workspaces WHERE id = ${N.ws}`).rows[0].setup_nudge_sent_at;
  assert(nres.statusCode === 200 && !nudged && mailsTo(N.email).length === before, 'no setup nudge the same day');
  await lastSentAgo(N.id, 30);
  nres = mkRes();
  await setupNudge({ method: 'POST', url: '/api/cron/setup-nudge', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, nres);
  nudged = (await sql`SELECT setup_nudge_sent_at FROM workspaces WHERE id = ${N.ws}`).rows[0].setup_nudge_sent_at;
  assert(!!nudged, 'setup nudge goes out the next day');

  console.log('\n[7] admin profile shows the reminders');
  const pres = mkRes();
  await adminProfile({ method: 'GET', url: '/x', query: { id: A.id },
    headers: { host: 'localhost:3000', 'x-admin-secret': process.env.ADMIN_SECRET } }, pres);
  const sr = pres.body?.account?.signupReminders;
  assert(pres.statusCode === 200 && sr?.sent === 3 && sr.of === 3 && !!sr.lastSentAt, `profile: sent 3 of 3 with a date (${JSON.stringify(sr)})`);
  assert(pres.body?.account?.emailConsent && pres.body.account.emailConsent.marketingAt === null, 'profile: marketing consent status included');

  console.log('\n[8] cron auth');
  const ares = mkRes();
  await cron(cronReq(false), ares);
  assert(ares.statusCode === 401, 'no cron secret: 401');
}

run()
  .catch((e) => { fail++; console.error('crashed:', e); })
  .finally(async () => {
    await cleanup().catch(() => {});
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
