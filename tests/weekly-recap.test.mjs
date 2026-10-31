// "Your week with Ivy": the weekly owner recap email + the cron that sends it
// + the dashboard "This week" card that shows the same numbers.
// Proves, against the real database:
//   • every number in the email matches seeded rows (bookings taken through
//     the booking page, sessions completed, money collected by any method,
//     outstanding, Ivy actions, automations, reminders, signed documents)
//   • rows whose number is zero are omitted
//   • the time-saved line is labelled as an estimate and states its per-task
//     assumption
//   • a workspace with no activity gets no email
//   • the weekly_recap_last_sent_at stamp prevents a second send
//   • lapsed / beta / sponsored / un-onboarded workspaces are skipped
//   • the copy has no vendor names and no em dashes
//   • Ivy's write tools land in the ivy_actions ledger, read tools do not
//   • /api/dashboard carries the same numbers as `week`, null when quiet
//
// Run: node --import ./tests/bootstrap.mjs ./tests/weekly-recap.test.mjs
process.env.RESEND_API_KEY ||= 're_test_not_real';
process.env.APP_URL ||= 'https://www.joinivy.ai';
process.env.ADMIN_SECRET ||= 'test-admin-secret';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import {
  renderWeeklyRecap, buildWeekStats, notifyWeeklyRecap, recapHasActivity, recapSubject,
  ivyTaskCount, timeSavedMinutes, MINUTES_PER_IVY_TASK,
} from '../api/_lib/weeklyRecap.js';
import { executeIvyTool, ivyActionKind } from '../api/_lib/ivyTools.js';
import recapCron from '../api/cron/owner-weekly-recap.js';
const { default: dashboard } = await import('../api/dashboard.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY);
const ahead = (days) => new Date(Date.now() + days * DAY);
const day = (d) => d.toISOString().slice(0, 10);

// Capture outbound provider calls instead of sending.
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('resend.com')) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const sentTo = (email) => sent.filter((m) => [].concat(m.to).includes(email));

function mockRes() {
  return { statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; } };
}
const cronReq = () => ({ method: 'GET', url: '/api/cron/owner-weekly-recap', query: {}, headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });
const dashReq = (uid) => ({ method: 'GET', url: '/dashboard', query: {}, on() {},
  headers: { host: 'localhost:3001', 'user-agent': 'test/1.0', cookie: `ivy_session=${signSession(uid)}` } });

// No vendor or model names, no em dashes, no "business OS" anywhere an owner reads.
const VENDOR = /\b(anthropic|claude|resend|twilio|openai)\b/i;
const EM_DASH = /—/;
const BIZ_OS = /business os/i;
// HTML comments never reach a reader; the shell's own are not copy.
const visible = (html) => String(html).replace(/<!--[\s\S]*?-->/g, '');

async function mkOwner(tag, { userType = 'regular', subStatus = 'active', periodEnd = ahead(30), trialEnd = null, onboarded = true } = {}) {
  const email = `wrecap-${tag}-${S}@example.com`;
  const u = await sql`INSERT INTO users (email, password_hash, name, user_type, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', 'Casey Owner', ${userType}, NOW(), '2026-05-05', NOW()) RETURNING id`;
  const userId = u.rows[0].id;
  const w = await sql`
    INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, trial_ends_at, onboarded_at)
    VALUES (${userId}, 'WS', ${subStatus}, ${periodEnd}, ${trialEnd}, ${onboarded ? ago(30) : null})
    RETURNING id`;
  const workspaceId = w.rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${workspaceId}, 'Casey Studio', ${`wrecap-${tag}-${S}`})
            ON CONFLICT (workspace_id) DO NOTHING`;
  return { userId, workspaceId, email };
}

async function booking(ws, { source = null, createdAt = new Date(), date, cancelled = false, noShow = false, remindersSent = {}, smsSent = {} }) {
  const r = await sql`
    INSERT INTO bookings (workspace_id, client_name, client_email, date, start_min, end_min, source, created_at,
                          cancelled_at, no_show_at, reminders_sent, sms_sent)
    VALUES (${ws}, 'Sam Client', 'sam@example.com', ${day(date)}::date, 600, 660, ${source}, ${createdAt},
            ${cancelled ? new Date() : null}, ${noShow ? new Date() : null},
            ${JSON.stringify(remindersSent)}::jsonb, ${JSON.stringify(smsSent)}::jsonb)
    RETURNING id`;
  return r.rows[0].id;
}
let invoiceN = 0;
async function invoice(ws, { status, rate, paidAt = null, paidAmount = null, dueDate = null, overdueReminderAt = null, dueSoonReminderAt = null }) {
  invoiceN += 1;
  await sql`
    INSERT INTO invoices (workspace_id, number, client_name, items, status, paid_at, paid_amount, due_date,
                          last_overdue_reminder_at, due_soon_reminder_sent_at)
    VALUES (${ws}, ${`WR-${S}-${invoiceN}`}, 'Sam Client', ${JSON.stringify([{ description: 'Session', quantity: 1, rate }])}::jsonb,
            ${status}, ${paidAt}, ${paidAmount}, ${dueDate ? day(dueDate) : null}, ${overdueReminderAt}, ${dueSoonReminderAt})`;
}

const created = [];

async function main() {
  await ensureSchemaApplied();
  await sql.query(`DELETE FROM users WHERE email LIKE 'wrecap-%@example.com'`);

  const busy  = await mkOwner('busy');
  const quiet = await mkOwner('quiet');
  const lapsed = await mkOwner('lapsed', { subStatus: 'active', periodEnd: ago(10) });
  const trialOver = await mkOwner('trialover', { subStatus: 'trialing', periodEnd: null, trialEnd: ago(2) });
  const beta = await mkOwner('beta', { userType: 'beta' });
  const sponsored = await mkOwner('sponsored', { userType: 'sponsored' });
  const unonboarded = await mkOwner('unonb', { onboarded: false });
  created.push(busy, quiet, lapsed, trialOver, beta, sponsored, unonboarded);

  // ── Seed the busy workspace ───────────────────────────────────────────
  const ws = busy.workspaceId;
  // Bookings taken through the booking page: 2 live + 1 cancelled (not counted)
  // + 1 owner-made (source NULL, not counted). The two live ones are next week.
  await booking(ws, { source: 'client', createdAt: ago(2), date: ahead(3) });
  await booking(ws, { source: 'client', createdAt: ago(1), date: ahead(5) });
  await booking(ws, { source: 'client', createdAt: ago(1), date: ahead(2), cancelled: true });
  // Sessions completed: 2 in the window, 1 no-show (not counted), 1 older (not counted).
  await booking(ws, { date: ago(1), remindersSent: { 1440: ago(2).toISOString() }, smsSent: { 60: ago(1).toISOString() } });
  await booking(ws, { date: ago(3), remindersSent: { 1440: ago(20).toISOString() } });
  await booking(ws, { date: ago(2), noShow: true });
  await booking(ws, { date: ago(12) });
  // Money: $500 by card + $340 marked paid by hand (no paid_amount snapshot,
  // falls back to the total) = $840 collected; an older $1,000 is outside.
  await invoice(ws, { status: 'paid', rate: 500, paidAt: ago(3), paidAmount: 500 });
  await invoice(ws, { status: 'paid', rate: 340, paidAt: ago(1) });
  await invoice(ws, { status: 'paid', rate: 1000, paidAt: ago(20), paidAmount: 1000 });
  // Outstanding: $200 sent (due-soon reminder went out) + $150 overdue
  // (overdue reminder went out) = $350, of which $150 is overdue.
  await invoice(ws, { status: 'sent', rate: 200, dueDate: ahead(5), dueSoonReminderAt: ago(1) });
  await invoice(ws, { status: 'overdue', rate: 150, dueDate: ago(5), overdueReminderAt: ago(2) });
  // What Ivy did: 3 invoices, 2 messages, 1 other; one old row outside the window.
  for (const [kind, tool, at] of [
    ['invoice', 'create_invoice', ago(1)], ['invoice', 'create_invoice', ago(2)], ['invoice', 'send_invoice', ago(2)],
    ['message', 'send_message_to_client', ago(3)], ['message', 'send_message_to_client', ago(4)],
    ['other', 'create_task', ago(5)],
    ['invoice', 'create_invoice', ago(9)],
  ]) {
    await sql`INSERT INTO ivy_actions (workspace_id, tool, kind, created_at) VALUES (${ws}, ${tool}, ${kind}, ${at})`;
  }
  // Automations: 2 succeeded + 1 failed + 1 skipped + 1 old → 2 ran.
  const wf = (await sql`INSERT INTO workflows (workspace_id, name, trigger_type) VALUES (${ws}, 'Welcome', 'client_created') RETURNING id`).rows[0].id;
  for (const [status, at] of [['succeeded', ago(1)], ['succeeded', ago(4)], ['failed', ago(2)], ['skipped', ago(2)], ['succeeded', ago(10)]]) {
    await sql`INSERT INTO workflow_runs (workflow_id, workspace_id, status, triggered_at) VALUES (${wf}, ${ws}, ${status}, ${at})`;
  }
  // Documents: 1 signed this week, 1 signed long ago, 1 draft.
  await sql`INSERT INTO documents (workspace_id, name, status, completed_at) VALUES (${ws}, 'Agreement', 'completed', ${ago(2)})`;
  await sql`INSERT INTO documents (workspace_id, name, status, completed_at) VALUES (${ws}, 'Old agreement', 'completed', ${ago(40)})`;
  await sql`INSERT INTO documents (workspace_id, name, status) VALUES (${ws}, 'Draft', 'draft')`;
  // One new client this week.
  await sql`INSERT INTO clients (workspace_id, name, email) VALUES (${ws}, 'Sam Client', 'sam@example.com')`;

  // The lapsed workspace had real activity too; it must still be skipped.
  await invoice(lapsed.workspaceId, { status: 'paid', rate: 300, paidAt: ago(1), paidAmount: 300 });

  const range = { from: ago(7), to: new Date() };

  console.log('\n[1] buildWeekStats matches the seeded rows');
  const stats = await buildWeekStats({ workspaceId: ws, ...range });
  assert(stats.bookingsTaken === 2, `bookings taken through the booking page = 2 (got ${stats.bookingsTaken})`);
  assert(stats.completedBookings === 2, `sessions completed = 2 (got ${stats.completedBookings})`);
  assert(stats.revenuePaid === 840, `money collected = 840 across card + manual mark paid (got ${stats.revenuePaid})`);
  assert(stats.outstandingTotal === 350 && stats.outstandingCount === 2, `outstanding = $350 across 2 invoices (got ${stats.outstandingTotal}/${stats.outstandingCount})`);
  assert(stats.ivyInvoices === 3, `Ivy invoices = 3 (got ${stats.ivyInvoices})`);
  assert(stats.ivyMessages === 2, `Ivy messages = 2 (got ${stats.ivyMessages})`);
  assert(stats.ivyOtherActions === 1 && stats.ivyDocuments === 0 && stats.ivyBookings === 0, 'other Ivy actions = 1, documents/bookings = 0');
  assert(stats.automationsRun === 2, `automations run = 2 (got ${stats.automationsRun})`);
  assert(stats.remindersSent === 4, `reminders sent = 4 (2 booking + 2 invoice) (got ${stats.remindersSent})`);
  assert(stats.documentsSigned === 1, `documents signed = 1 (got ${stats.documentsSigned})`);
  assert(stats.newClients === 1, `new clients = 1 (got ${stats.newClients})`);
  assert(stats.upcomingBookings === 2, `next 7 days = 2 sessions (got ${stats.upcomingBookings})`);
  assert(stats.overdueInvoiceCount === 1 && stats.overdueInvoiceTotal === 150, 'overdue = 1 invoice, $150');
  assert(ivyTaskCount(stats) === 12 && timeSavedMinutes(stats) === 12 * MINUTES_PER_IVY_TASK, `task count 12, time saved ${12 * MINUTES_PER_IVY_TASK} minutes`);

  console.log('\n[2] the email shows those numbers, omits zero rows, labels the estimate');
  const r = renderWeeklyRecap({ firstName: 'Casey', businessName: 'Casey Studio', range, stats });
  assert(r.subject === 'Your week with Ivy: 2 bookings, $840 collected', `subject: ${r.subject}`);
  assert(r.html.includes('Bookings taken') && r.html.includes('Sessions completed') && r.html.includes('>$840<') && r.html.includes('>$350<'), 'headline tiles: bookings, sessions, collected, outstanding');
  assert(r.html.includes('Ivy drafted or sent 3 invoices'), 'Ivy invoices row');
  assert(r.html.includes('Ivy drafted 2 messages to clients'), 'Ivy messages row');
  assert(r.html.includes('Ivy handled 1 other task'), 'other Ivy tasks row (singular)');
  assert(r.html.includes('2 automations ran'), 'automations row');
  assert(r.html.includes('4 reminders sent to clients'), 'reminders row');
  assert(r.html.includes('1 document signed'), 'documents signed row');
  assert(!r.html.includes('Ivy prepared or sent') && !r.html.includes('Ivy booked, moved'), 'zero rows (Ivy documents, Ivy bookings) are omitted');
  assert(!/\b0 (invoice|message|automation|reminder|document|session|booking|task)/.test(r.html), 'no "0 something" anywhere');
  assert(r.html.includes(`Time saved: about ${12 * MINUTES_PER_IVY_TASK} minutes`), 'time saved line');
  assert(r.html.includes(`Estimate: ${MINUTES_PER_IVY_TASK} minutes per task Ivy handled, across 12 tasks`), 'the estimate names its per-task assumption and the task count');
  assert(r.html.includes('2 sessions</strong> booked for the next 7 days') && r.html.includes('/calendar"'), 'next week: sessions line links to the calendar');
  assert(r.html.includes('1 overdue invoice</strong> worth $150') && r.html.includes('/finance?filter=overdue'), 'next week: overdue line deep-links to overdue invoices');
  assert(r.html.includes('Casey Studio') && r.html.includes('Hi Casey'), 'greets by first name and names the business');
  assert(!/\{\{\s*\w+\s*\}\}/.test(r.html), 'no leftover merge tokens');

  console.log('\n[3] copy hygiene: no vendor or model names, no em dashes, no "business OS"');
  for (const [label, text] of [['subject', r.subject], ['body', visible(r.html)], ['preheader', r.preheader]]) {
    assert(!VENDOR.test(text), `${label}: no vendor names`);
    assert(!EM_DASH.test(text), `${label}: no em dashes`);
    assert(!BIZ_OS.test(text), `${label}: never "business OS"`);
  }

  console.log('\n[4] zero-activity rendering + subject fallbacks');
  const onlyIvy = { ivyMessages: 3, automationsRun: 1 };
  const r2 = renderWeeklyRecap({ firstName: 'Pat', businessName: 'Pat Studio', range, stats: onlyIvy });
  assert(recapSubject(onlyIvy) === 'Your week with Ivy: 4 tasks handled', `subject with only Ivy work: ${recapSubject(onlyIvy)}`);
  assert(!r2.html.includes('Bookings taken') && !r2.html.includes('Collected'), 'no tile row when every headline number is zero');
  assert(r2.html.includes('Nothing booked for the next 7 days yet') && r2.html.includes('calendar?share=1'), 'empty week ahead offers the booking link');
  const r3 = renderWeeklyRecap({ firstName: 'Pat', businessName: 'Pat Studio', range, stats: { completedBookings: 3, revenuePaid: 120 } });
  assert(!r3.html.includes('Time saved'), 'time-saved line omitted when Ivy handled nothing');
  assert(!r3.html.includes('What Ivy did'), 'Ivy list omitted when every row is zero');
  assert(recapHasActivity({}) === false && recapHasActivity({ upcomingBookings: 4, overdueInvoiceCount: 2 }) === false, 'future bookings and overdue balance alone are not activity');
  assert(recapHasActivity({ remindersSent: 1 }) === true, 'one reminder counts as activity');

  console.log('\n[5] notifyWeeklyRecap: busy owner is emailed, quiet owner is not');
  sent.length = 0;
  const n1 = await notifyWeeklyRecap({ workspaceId: ws, ...range });
  assert(n1.sent === true && sentTo(busy.email).length === 1, 'busy owner gets exactly one email');
  assert(sentTo(busy.email)[0]?.subject === 'Your week with Ivy: 2 bookings, $840 collected', 'provider call carries the subject');
  assert(/Unsubscribe/.test(sentTo(busy.email)[0]?.html || ''), 'footer carries the unsubscribe links from sendEmailToUser');
  const n2 = await notifyWeeklyRecap({ workspaceId: quiet.workspaceId, ...range });
  assert(n2.sent === false && n2.reason === 'no-activity' && sentTo(quiet.email).length === 0, 'quiet owner: no email, reason no-activity');

  console.log('\n[6] cron: sends once, stamps, skips lapsed / expired trial / beta / sponsored / un-onboarded');
  sent.length = 0;
  let res = mockRes();
  await recapCron(cronReq(), res);
  assert(res.statusCode === 200 && res.body?.ok === true, 'cron returns 200');
  assert(sentTo(busy.email).length === 1, 'busy owner emailed once by the cron');
  assert(sentTo(quiet.email).length === 0, 'quiet owner not emailed');
  const stamp = async (id) => (await sql`SELECT weekly_recap_last_sent_at FROM workspaces WHERE id = ${id}`).rows[0].weekly_recap_last_sent_at;
  const busyStamp = await stamp(ws);
  assert(!!busyStamp, 'busy workspace stamped');
  assert(!!(await stamp(quiet.workspaceId)), 'quiet workspace stamped too (no re-scan next batch)');
  for (const c of [lapsed, trialOver, beta, sponsored, unonboarded]) {
    const st = await stamp(c.workspaceId);
    assert(st === null && sentTo(c.email).length === 0, `skipped and not stamped: ${c.email.split('-')[1]}`);
  }

  console.log('\n[7] the stamp prevents a second send inside the week');
  res = mockRes();
  await recapCron(cronReq(), res);
  assert(sentTo(busy.email).length === 1, 'still exactly one email after a second run');
  assert(String(await stamp(ws)) === String(busyStamp), 'stamp unchanged on re-run');
  // Backdate the stamp 8 days: the next run sends again.
  await sql`UPDATE workspaces SET weekly_recap_last_sent_at = NOW() - INTERVAL '8 days' WHERE id = ${ws}`;
  res = mockRes();
  await recapCron(cronReq(), res);
  assert(sentTo(busy.email).length === 2, 'a week later the owner gets the next recap');

  console.log('\n[8] no admin auth → 401');
  res = mockRes();
  await recapCron({ method: 'GET', url: '/x', query: {}, headers: {} }, res);
  assert(res.statusCode === 401, 'no auth → 401');

  console.log('\n[9] Ivy action ledger: write tools are recorded, read tools are not');
  assert(ivyActionKind('create_invoice') === 'invoice' && ivyActionKind('send_message_to_client') === 'message', 'kinds for invoice + message tools');
  assert(ivyActionKind('list_tasks') === null && ivyActionKind('remember') === null && ivyActionKind('nope') === null, 'read, memory and unknown tools are not recorded');
  const before = Number((await sql`SELECT COUNT(*)::int AS n FROM ivy_actions WHERE workspace_id = ${quiet.workspaceId}`).rows[0].n);
  await executeIvyTool('list_tasks', {}, { workspaceId: quiet.workspaceId, userId: quiet.userId });
  const t = await executeIvyTool('create_task', { title: `Recap test ${S}` }, { workspaceId: quiet.workspaceId, userId: quiet.userId });
  assert(t?.task?.id, 'create_task ran');
  const bad = await executeIvyTool('create_task', {}, { workspaceId: quiet.workspaceId, userId: quiet.userId });
  assert(!!bad.error, 'create_task without a title errors');
  const ledger = (await sql`SELECT tool, kind FROM ivy_actions WHERE workspace_id = ${quiet.workspaceId} ORDER BY created_at`).rows;
  assert(ledger.length === before + 1 && ledger.at(-1).tool === 'create_task' && ledger.at(-1).kind === 'other', 'exactly one ledger row: the successful write (not the read, not the failure)');
  const gated = await executeIvyTool('send_invoice', { invoice_id: '00000000-0000-0000-0000-000000000000' }, { workspaceId: quiet.workspaceId, userId: quiet.userId });
  assert(gated.needs_confirmation === true, 'sensitive tool asks for confirmation');
  const after = Number((await sql`SELECT COUNT(*)::int AS n FROM ivy_actions WHERE workspace_id = ${quiet.workspaceId}`).rows[0].n);
  assert(after === before + 1, 'a confirmation prompt is not recorded as an action');

  console.log('\n[10] dashboard carries the same numbers as `week`, null for a quiet workspace');
  res = mockRes();
  await dashboard(dashReq(busy.userId), res);
  const wk = res.body?.week;
  assert(res.statusCode === 200 && wk, 'dashboard 200 with week');
  assert(wk?.bookingsTaken === 2 && wk?.completedBookings === 2 && wk?.revenuePaid === 840 && wk?.outstandingTotal === 350, 'week tiles match');
  assert(wk?.ivyTasks === 12 && wk?.timeSavedMinutes === 12 * MINUTES_PER_IVY_TASK && wk?.minutesPerTask === MINUTES_PER_IVY_TASK, 'week carries the task count, estimate and assumption');
  assert(Array.isArray(wk?.ivyRows) && wk.ivyRows.includes('Ivy drafted or sent 3 invoices') && wk.ivyRows.length === 6, 'week rows match the email rows');
  assert(wk?.upcomingBookings === 2 && wk?.overdueInvoiceCount === 1, 'week ahead numbers present');
  // The quiet workspace now has one Ivy action from [9]; wipe it so it is quiet again.
  await sql`DELETE FROM ivy_actions WHERE workspace_id = ${quiet.workspaceId}`;
  await sql`DELETE FROM tasks WHERE workspace_id = ${quiet.workspaceId}`;
  res = mockRes();
  await dashboard(dashReq(quiet.userId), res);
  assert(res.statusCode === 200 && res.body?.week === null, 'quiet workspace: week is null (card hidden)');
}

main()
  .catch((e) => { console.error('crashed:', e); fail++; })
  .finally(async () => {
    for (const c of created) {
      await sql`DELETE FROM users WHERE id = ${c.userId}`.catch(() => {});
    }
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
