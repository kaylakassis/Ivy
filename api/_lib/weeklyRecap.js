// Weekly owner recap email: "Here is what Ivy did for you this week."
//
// Sent every Monday morning to every active business owner (trialing or
// paid) with the last 7 days in real numbers: bookings taken through the
// booking page, sessions completed, money collected and outstanding, and
// the work Ivy did (invoices drafted or sent, messages drafted,
// automations run, reminders sent, documents signed) with an estimate of
// the time that saved. Cron lives at api/cron/owner-weekly-recap.js;
// owners can opt out via the 'reports' email preference.
//
// Every number comes from the owner's own rows. A row is shown only when
// its number is above zero, and a workspace with nothing at all in the
// window gets no email that week (notifyWeeklyRecap returns
// reason: 'no-activity').
//
// Like the other render*/notify pairs in this codebase, `renderWeeklyRecap`
// is a pure function called by BOTH the production cron AND the admin
// preview endpoint, so editing copy here updates both places.
// `buildWeekStats` is shared with the dashboard's "This week" card.
import { sql } from './db.js';
import { sendEmailToUser, emailShell } from './email.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';

// The time-saved line is an estimate, and the email says so next to the
// number: this many minutes for each task Ivy handled (an Ivy action, an
// automation run, or a reminder sent). Change it here and the copy follows.
export const MINUTES_PER_IVY_TASK = 4;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function firstName(name) { return (name || '').split(/\s+/)[0] || 'there'; }
function plural(n, one, many = `${one}s`) { return `${n} ${n === 1 ? one : many}`; }
function fmtRange({ from, to }) {
  const f = from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const t = to.toLocaleDateString('en-US',   { month: 'short', day: 'numeric' });
  return `${f} to ${t}`;
}

const num = (v) => Number(v || 0);

// Everything Ivy or the platform did on the owner's behalf. This is the
// task count the time-saved estimate is built from.
export function ivyTaskCount(stats) {
  const s = stats || {};
  return num(s.ivyInvoices) + num(s.ivyMessages) + num(s.ivyDocuments) + num(s.ivyBookings)
    + num(s.ivyOtherActions) + num(s.automationsRun) + num(s.remindersSent);
}

export function timeSavedMinutes(stats) {
  return ivyTaskCount(stats) * MINUTES_PER_IVY_TASK;
}

// "about 24 minutes" under an hour and a half, "about 2.5 hours" above.
export function fmtTimeSaved(minutes) {
  const m = Math.round(Number(minutes || 0));
  if (m < 90) return `about ${plural(m, 'minute')}`;
  const h = Math.round((m / 60) * 10) / 10;
  return `about ${h} ${h === 1 ? 'hour' : 'hours'}`;
}

// Did anything happen in the window? Future bookings and the overdue
// balance are a state, not something that happened this week, so they do
// not count. A workspace with no activity gets no email.
export function recapHasActivity(stats) {
  const s = stats || {};
  return [
    s.bookingsTaken, s.completedBookings, s.newClients, s.revenuePaid,
    s.documentsSigned, ivyTaskCount(s),
  ].some((v) => num(v) > 0);
}

// "Your week with Ivy: 6 bookings, $840 collected". Up to two of the
// biggest facts, picked in a fixed order so the subject is predictable.
export function recapSubject(stats) {
  const s = stats || {};
  const parts = [];
  if (num(s.bookingsTaken) > 0) parts.push(plural(num(s.bookingsTaken), 'booking'));
  else if (num(s.completedBookings) > 0) parts.push(plural(num(s.completedBookings), 'session'));
  if (num(s.revenuePaid) > 0) parts.push(`${fmtMoney(s.revenuePaid)} collected`);
  const tasks = ivyTaskCount(s);
  if (parts.length < 2 && tasks > 0) parts.push(`${plural(tasks, 'task')} handled`);
  if (parts.length < 2 && num(s.documentsSigned) > 0) parts.push(plural(num(s.documentsSigned), 'document signed', 'documents signed'));
  if (parts.length < 2 && num(s.newClients) > 0) parts.push(plural(num(s.newClients), 'new client'));
  return parts.length ? `Your week with Ivy: ${parts.slice(0, 2).join(', ')}` : 'Your week with Ivy';
}

// Stat tile used in the headline row. One number + one label.
function statTile(label, value, widthPct) {
  return `<td style="padding:14px 16px;background:#0B4136;border:1px solid #164B3F;border-radius:10px;vertical-align:top;width:${widthPct}%;">
    <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;color:#93A3A0;">${escapeHtml(label)}</div>
    <div style="margin-top:6px;font-family:'Neue Haas Grotesk Display','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:28px;letter-spacing:-0.02em;font-weight:500;color:#ECF0F1;line-height:1;">${escapeHtml(String(value))}</div>
  </td>`;
}

// The headline tiles, in priority order, only those above zero, at most 4.
export function recapTiles(stats) {
  const s = stats || {};
  const all = [
    { key: 'bookingsTaken',     label: 'Bookings taken',     value: num(s.bookingsTaken),     display: String(num(s.bookingsTaken)) },
    { key: 'completedBookings', label: 'Sessions completed', value: num(s.completedBookings), display: String(num(s.completedBookings)) },
    { key: 'revenuePaid',       label: 'Collected',          value: num(s.revenuePaid),       display: fmtMoney(s.revenuePaid) },
    { key: 'outstandingTotal',  label: 'Outstanding',        value: num(s.outstandingTotal),  display: fmtMoney(s.outstandingTotal) },
    { key: 'newClients',        label: 'New clients',        value: num(s.newClients),        display: String(num(s.newClients)) },
  ];
  return all.filter((t) => t.value > 0).slice(0, 4);
}

// The "what Ivy did" rows, only those above zero. Shared by the email and
// the dashboard card so the two never disagree on wording.
export function recapIvyRows(stats) {
  const s = stats || {};
  const rows = [
    [num(s.ivyInvoices),     (n) => `Ivy drafted or sent ${plural(n, 'invoice')}`],
    [num(s.ivyMessages),     (n) => `Ivy drafted ${plural(n, 'message')} to clients`],
    [num(s.ivyDocuments),    (n) => `Ivy prepared or sent ${plural(n, 'document')}`],
    [num(s.ivyBookings),     (n) => `Ivy booked, moved or cancelled ${plural(n, 'session')}`],
    [num(s.ivyOtherActions), (n) => `Ivy handled ${plural(n, 'other task')}`],
    [num(s.automationsRun),  (n) => `${plural(n, 'automation')} ran`],
    [num(s.remindersSent),   (n) => `${plural(n, 'reminder')} sent to clients`],
    [num(s.documentsSigned), (n) => `${plural(n, 'document')} signed`],
  ];
  return rows.filter(([n]) => n > 0).map(([n, text]) => text(n));
}

export function renderWeeklyRecap({ firstName: fnRaw, businessName, range, stats }) {
  const fn = escapeHtml(firstName(fnRaw));
  const biz = escapeHtml(businessName || 'your business');
  const s = stats || {};
  const rangeLabel = range ? fmtRange(range) : '';
  const base = appUrl();

  const tiles = recapTiles(s);
  const ivyRows = recapIvyRows(s);
  const tasks = ivyTaskCount(s);
  const upcoming = num(s.upcomingBookings);
  const overdueCount = num(s.overdueInvoiceCount);
  const overdueTotal = num(s.overdueInvoiceTotal);

  const tileRow = tiles.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:8px;margin:8px -8px;">
        <tr>${tiles.map((t) => statTile(t.label, t.display, Math.floor(100 / tiles.length))).join('')}</tr>
      </table>`
    : '';

  const ivyList = ivyRows.length
    ? `<p style="margin:22px 0 6px;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:#93A3A0;">What Ivy did</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${ivyRows.map((text) => `<tr><td style="padding:6px 0;font-size:14px;line-height:1.5;color:#ECF0F1;border-bottom:1px solid #164B3F;">${escapeHtml(text)}</td></tr>`).join('')}
      </table>`
    : '';

  const timeSaved = tasks > 0
    ? `<p style="margin:16px 0 2px;font-size:15px;color:#ECF0F1;"><strong>Time saved: ${escapeHtml(fmtTimeSaved(timeSavedMinutes(s)))}</strong></p>
      <p style="margin:0;font-size:11.5px;line-height:1.5;color:#93A3A0;">Estimate: ${MINUTES_PER_IVY_TASK} minutes per task Ivy handled, across ${plural(tasks, 'task')} this week (Ivy actions, automations and reminders).</p>`
    : '';

  const nextWeekParts = [];
  if (upcoming > 0) {
    nextWeekParts.push(`<strong>${plural(upcoming, 'session')}</strong> booked for the next 7 days. <a href="${base}/calendar" style="color:#5CC98E;text-decoration:underline;">Open the calendar</a>`);
  }
  if (overdueCount > 0) {
    nextWeekParts.push(`<strong style="color:#FFA040;">${plural(overdueCount, 'overdue invoice')}</strong> worth ${fmtMoney(overdueTotal)} to chase. <a href="${base}/finance?filter=overdue" style="color:#5CC98E;text-decoration:underline;">See them</a>`);
  }
  if (nextWeekParts.length === 0) {
    nextWeekParts.push(`Nothing booked for the next 7 days yet. <a href="${base}/calendar?share=1" style="color:#5CC98E;text-decoration:underline;">Share your booking link</a>`);
  }
  const nextWeek = `<p style="margin:22px 0 6px;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:#93A3A0;">Next week</p>
    ${nextWeekParts.map((p) => `<p style="margin:4px 0;font-size:14px;line-height:1.55;color:#ECF0F1;">${p}</p>`).join('')}`;

  const subject = recapSubject(s);
  const preheader = `${rangeLabel ? `${rangeLabel}. ` : ''}${subject.replace(/^Your week with Ivy:?\s*/, '') || 'Your week in numbers.'}`;

  const html = emailShell({
    heading: 'Your week with Ivy',
    preheader,
    body: `<p>Hi ${fn},</p>
      <p>Here is what happened at ${biz} last week${rangeLabel ? ` (${escapeHtml(rangeLabel)})` : ''}, in real numbers.</p>
      ${tileRow}
      ${ivyList}
      ${timeSaved}
      ${nextWeek}`,
    ctaText: 'Open dashboard',
    ctaUrl: `${base}/`,
    footer: `You're getting this as the owner of ${biz}. The Ivy Team`,
  });
  return { subject, html, preheader };
}

const safeQ = async (p, fallback) => { try { return await p; } catch { return fallback; } };
const n0 = (r) => Number(r?.rows?.[0]?.n || 0);

// Everything the recap and the dashboard card show, for one workspace over
// [from, to). Each leg degrades to 0 rather than throwing so one missing
// table never blocks the email.
export async function buildWeekStats({ workspaceId, from, to }) {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const fromDay = fromIso.slice(0, 10);
  const toDay = toIso.slice(0, 10);
  const zero = { rows: [{ n: 0 }] };

  const [
    bookingsTaken, completed, newClients, revenue, outstanding,
    ivyActions, automations, reminders, documentsSigned,
    upcoming, overdue,
  ] = await Promise.all([
    // Bookings clients made themselves through the public booking page or
    // a package they hold (bookings.source = 'client'). Owner-made rows
    // leave source NULL and are not counted here.
    safeQ(sql`
      SELECT COUNT(*)::int AS n FROM bookings
       WHERE workspace_id = ${workspaceId}
         AND source = 'client'
         AND cancelled_at IS NULL
         AND created_at >= ${fromIso}::timestamptz
         AND created_at <  ${toIso}::timestamptz
    `, zero),
    // Sessions whose day fell inside the window, not cancelled, not a
    // no-show. The window ends now, so these have all taken place.
    safeQ(sql`
      SELECT COUNT(*)::int AS n FROM bookings
       WHERE workspace_id = ${workspaceId}
         AND cancelled_at IS NULL
         AND no_show_at IS NULL
         AND date >= ${fromDay}::date
         AND date <  ${toDay}::date
    `, zero),
    safeQ(sql`
      SELECT COUNT(*)::int AS n FROM clients
       WHERE workspace_id = ${workspaceId}
         AND created_at >= ${fromIso}::timestamptz
         AND created_at <  ${toIso}::timestamptz
    `, zero),
    // Money collected: invoices marked paid in the window by any method
    // (card checkout, the manual Mark paid button, a confirmed claim).
    // paid_amount is the snapshot written at payment time; older rows
    // fall back to the invoice total.
    safeQ(sql`
      SELECT COALESCE(SUM(COALESCE(paid_amount, total)), 0)::numeric AS total
        FROM invoices
       WHERE workspace_id = ${workspaceId}
         AND status = 'paid'
         AND paid_at >= ${fromIso}::timestamptz
         AND paid_at <  ${toIso}::timestamptz
    `, { rows: [{ total: 0 }] }),
    safeQ(sql`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::numeric AS total
        FROM invoices
       WHERE workspace_id = ${workspaceId}
         AND status IN ('sent', 'overdue')
    `, { rows: [{ n: 0, total: 0 }] }),
    // What Ivy did: one row per completed write tool (api/_lib/ivyTools.js).
    safeQ(sql`
      SELECT kind, COUNT(*)::int AS n FROM ivy_actions
       WHERE workspace_id = ${workspaceId}
         AND created_at >= ${fromIso}::timestamptz
         AND created_at <  ${toIso}::timestamptz
       GROUP BY kind
    `, { rows: [] }),
    // Automations that actually did something (at least one action ran).
    safeQ(sql`
      SELECT COUNT(*)::int AS n FROM workflow_runs
       WHERE workspace_id = ${workspaceId}
         AND status IN ('succeeded', 'partial')
         AND triggered_at >= ${fromIso}::timestamptz
         AND triggered_at <  ${toIso}::timestamptz
    `, zero),
    // Reminders: booking reminders stamp reminders_sent[<minutes>] (email)
    // and sms_sent[<minutes>] (text) with the send time; invoice reminders
    // stamp last_overdue_reminder_at and due_soon_reminder_sent_at.
    safeQ(sql.query(
      `SELECT (
          (SELECT COUNT(*) FROM bookings b
             CROSS JOIN LATERAL jsonb_each_text(COALESCE(b.reminders_sent, '{}'::jsonb)) e
            WHERE b.workspace_id = $1
              AND (CASE WHEN e.value ~ '^\\d{4}-\\d{2}-\\d{2}' THEN e.value::timestamptz END) >= $2::timestamptz
              AND (CASE WHEN e.value ~ '^\\d{4}-\\d{2}-\\d{2}' THEN e.value::timestamptz END) <  $3::timestamptz)
        + (SELECT COUNT(*) FROM bookings b
             CROSS JOIN LATERAL jsonb_each_text(COALESCE(b.sms_sent, '{}'::jsonb)) e
            WHERE b.workspace_id = $1
              AND (CASE WHEN e.value ~ '^\\d{4}-\\d{2}-\\d{2}' THEN e.value::timestamptz END) >= $2::timestamptz
              AND (CASE WHEN e.value ~ '^\\d{4}-\\d{2}-\\d{2}' THEN e.value::timestamptz END) <  $3::timestamptz)
        + (SELECT COUNT(*) FROM invoices
            WHERE workspace_id = $1
              AND last_overdue_reminder_at >= $2::timestamptz AND last_overdue_reminder_at < $3::timestamptz)
        + (SELECT COUNT(*) FROM invoices
            WHERE workspace_id = $1
              AND due_soon_reminder_sent_at >= $2::timestamptz AND due_soon_reminder_sent_at < $3::timestamptz)
       )::int AS n`,
      [workspaceId, fromIso, toIso],
    ), zero),
    safeQ(sql`
      SELECT COUNT(*)::int AS n FROM documents
       WHERE workspace_id = ${workspaceId}
         AND status = 'completed'
         AND completed_at >= ${fromIso}::timestamptz
         AND completed_at <  ${toIso}::timestamptz
    `, zero),
    // Next 7 days, as of now.
    safeQ(sql.query(
      `SELECT COUNT(*)::int AS n FROM bookings
        WHERE workspace_id = $1
          AND cancelled_at IS NULL
          AND date >= CURRENT_DATE
          AND date <  CURRENT_DATE + INTERVAL '7 days'`,
      [workspaceId],
    ), zero),
    safeQ(sql`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::numeric AS total
        FROM invoices
       WHERE workspace_id = ${workspaceId}
         AND status IN ('sent', 'overdue')
         AND due_date IS NOT NULL
         AND due_date < CURRENT_DATE
    `, { rows: [{ n: 0, total: 0 }] }),
  ]);

  const byKind = {};
  for (const r of ivyActions.rows || []) byKind[r.kind] = Number(r.n || 0);

  return {
    bookingsTaken:       n0(bookingsTaken),
    completedBookings:   n0(completed),
    newClients:          n0(newClients),
    revenuePaid:         Number(revenue.rows[0]?.total || 0),
    outstandingCount:    n0(outstanding),
    outstandingTotal:    Number(outstanding.rows[0]?.total || 0),
    ivyInvoices:         byKind.invoice || 0,
    ivyMessages:         byKind.message || 0,
    ivyDocuments:        byKind.document || 0,
    ivyBookings:         byKind.booking || 0,
    ivyOtherActions:     byKind.other || 0,
    automationsRun:      n0(automations),
    remindersSent:       n0(reminders),
    documentsSigned:     n0(documentsSigned),
    upcomingBookings:    n0(upcoming),
    overdueInvoiceCount: n0(overdue),
    overdueInvoiceTotal: Number(overdue.rows[0]?.total || 0),
  };
}

// Owner snapshot: profile + business name in one query (mirroring
// loadOwner in subscriptionNotify).
async function loadOwner(workspaceId) {
  const { rows } = await sql`
    SELECT w.owner_id, u.email, u.name, cs.biz_name
      FROM workspaces w
      LEFT JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
     WHERE w.id = ${workspaceId}
  `;
  return rows[0] || null;
}

export async function notifyWeeklyRecap({ workspaceId, from, to }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return { sent: false, reason: 'no-owner-email' };
    const stats = await buildWeekStats({ workspaceId, from, to });
    // Nothing happened: no email this week rather than an empty recap.
    if (!recapHasActivity(stats)) return { sent: false, reason: 'no-activity', stats };
    const rendered = renderWeeklyRecap({
      firstName: firstName(o.name),
      businessName: o.biz_name,
      range: { from, to },
      stats,
    });
    const result = await sendEmailToUser({
      userId: o.owner_id, type: 'reports',
      to: o.email, subject: rendered.subject, html: rendered.html,
    });
    return { ...result, stats };
  } catch (err) {
    console.error('[weeklyRecap] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
    return { sent: false, reason: err.message };
  }
}
