// Weekly owner recap email.
//
// Sent every Monday morning to every active business owner (trialing or
// paid) with a snapshot of the prior 7 days: bookings, revenue, new
// clients, overdue invoices, what's coming up. Cron lives at
// api/cron/owner-weekly-recap.js; owners can opt out via the 'reports'
// email preference.
//
// Like the other render*/notify pairs in this codebase, `renderWeeklyRecap`
// is a pure function called by BOTH the production cron AND the admin
// preview endpoint — so editing copy here updates both places.
import { sql } from './db.js';
import { sendEmailToUser, emailShell } from './email.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function firstName(name) { return (name || '').split(/\s+/)[0] || 'there'; }
function fmtRange({ from, to }) {
  const f = from.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const t = to.toLocaleDateString('en-US',   { month: 'short', day: 'numeric' });
  return `${f} – ${t}`;
}

// Stat tile used in the body grid. Keeps the layout consistent and the
// copy short — every tile is one number + one label, with optional
// secondary context underneath.
function statTile(label, value, sub) {
  return `<td style="padding:14px 16px;background:#1D2022;border:1px solid #262A2D;border-radius:10px;vertical-align:top;width:50%;">
    <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;color:#8A8D85;">${escapeHtml(label)}</div>
    <div style="margin-top:6px;font-family:'Fraunces','Iowan Old Style',Georgia,serif;font-size:30px;letter-spacing:-0.02em;font-weight:500;color:#F3F3EE;line-height:1;">${escapeHtml(String(value))}</div>
    ${sub ? `<div style="margin-top:4px;font-size:12px;color:#C9CAC3;line-height:1.4;">${escapeHtml(sub)}</div>` : ''}
  </td>`;
}

export function renderWeeklyRecap({ firstName: fnRaw, businessName, range, stats }) {
  const fn = escapeHtml(firstName(fnRaw));
  const biz = escapeHtml(businessName || 'your business');
  const s = stats || {};
  const rangeLabel = range ? fmtRange(range) : '';

  const newClients   = s.newClients   || 0;
  const completed    = s.completedBookings || 0;
  const upcoming     = s.upcomingBookings  || 0;
  const revenue      = s.revenuePaid || 0;
  const overdueCount = s.overdueInvoiceCount || 0;
  const overdueTotal = s.overdueInvoiceTotal || 0;

  // One-line "the headline" depending on the week's shape. Lets the
  // email feel personal even though the data is the same query.
  const headline =
    completed === 0 && newClients === 0
      ? `A quiet one for ${biz} last week. Here's what's on deck.`
    : revenue > 0
      ? `Last week at ${biz}: ${fmtMoney(revenue)} earned across ${completed} session${completed === 1 ? '' : 's'}.`
      : `${completed} session${completed === 1 ? '' : 's'} wrapped up at ${biz} last week.`;

  const overdueBlock = overdueCount > 0
    ? `<p style="margin:18px 0 4px;font-size:14px;color:#F3F3EE;">
        <strong style="color:#FFA040;">${overdueCount} invoice${overdueCount === 1 ? '' : 's'} overdue</strong> · ${fmtMoney(overdueTotal)} outstanding.
        <a href="${appUrl()}/finance?filter=overdue" style="color:#CFFF50;text-decoration:underline;">Chase them →</a>
      </p>`
    : '';

  const upcomingBlock = upcoming > 0
    ? `<p style="margin:18px 0 4px;font-size:14px;color:#F3F3EE;">
        <strong>${upcoming} session${upcoming === 1 ? '' : 's'} coming up</strong> this week.
        <a href="${appUrl()}/calendar" style="color:#CFFF50;text-decoration:underline;">Open the calendar →</a>
      </p>`
    : `<p style="margin:18px 0 4px;font-size:14px;color:#C9CAC3;">
        No sessions on the books for the week ahead.
        <a href="${appUrl()}/calendar?share=1" style="color:#CFFF50;text-decoration:underline;">Share your booking link →</a>
      </p>`;

  const html = emailShell({
    heading: `Your week at ${businessName || 'your business'}`,
    preheader: `${rangeLabel} · ${completed} session${completed === 1 ? '' : 's'}, ${fmtMoney(revenue)} earned, ${newClients} new client${newClients === 1 ? '' : 's'}.`,
    body: `<p>Hi ${fn},</p>
      <p>${headline}</p>
      ${rangeLabel ? `<p style="font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:#8A8D85;margin:18px 0 8px;">${escapeHtml(rangeLabel)}</p>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:8px;margin:8px -8px;">
        <tr>
          ${statTile('Revenue',         fmtMoney(revenue),        completed ? `${completed} session${completed === 1 ? '' : 's'} completed` : null)}
          ${statTile('New clients',     newClients,               newClients ? 'Welcome them onboard' : null)}
        </tr>
        <tr>
          ${statTile('Coming up',       upcoming,                 upcoming ? 'In the next 7 days' : 'Empty calendar')}
          ${statTile('Overdue',         fmtMoney(overdueTotal),   overdueCount ? `${overdueCount} invoice${overdueCount === 1 ? '' : 's'}` : 'Caught up')}
        </tr>
      </table>
      ${overdueBlock}
      ${upcomingBlock}
      <p style="margin-top:24px;font-size:13.5px;line-height:1.6;color:#C9CAC3;">
        Open the dashboard for the full picture — Ivy can break any of this down further if you ask.
      </p>`,
    ctaText: 'Open dashboard',
    ctaUrl: `${appUrl()}/`,
    footer: `You're getting this as the owner of ${biz}. Don't want the weekly recap? Adjust your email preferences in <a href="${appUrl()}/account?tab=notifications" style="color:#CFFF50;text-decoration:underline;">Account → Notifications</a>. — The Ivy OS Team`,
  });
  return {
    subject: `Your week at ${businessName || 'your business'}${rangeLabel ? ` · ${rangeLabel}` : ''}`,
    html,
    preheader: `${rangeLabel} · ${completed} session${completed === 1 ? '' : 's'}, ${fmtMoney(revenue)} earned, ${newClients} new client${newClients === 1 ? '' : 's'}.`,
  };
}

// Collect the snapshot for one workspace over a [from, to] window.
// All queries are wrapped in defensive safe() so a missing column or
// table degrades the value to 0 rather than throwing the whole recap.
async function buildStats({ workspaceId, from, to }) {
  const safe = async (p, fallback) => { try { return await p; } catch { return fallback; } };
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const [newClients, completed, upcoming, revenue, overdue] = await Promise.all([
    safe(sql`
      SELECT COUNT(*)::int AS n
        FROM clients
       WHERE workspace_id = ${workspaceId}
         AND created_at >= ${fromIso}::timestamptz
         AND created_at <  ${toIso}::timestamptz
    `, { rows: [{ n: 0 }] }),
    // Bookings whose date is in the past week. We count rows that
    // weren't cancelled regardless of completion-log state — for the
    // summary, that's close enough to "happened."
    safe(sql`
      SELECT COUNT(*)::int AS n
        FROM bookings
       WHERE workspace_id = ${workspaceId}
         AND cancelled_at IS NULL
         AND date >= ${from.toISOString().slice(0, 10)}::date
         AND date <  ${to.toISOString().slice(0, 10)}::date
    `, { rows: [{ n: 0 }] }),
    // Bookings in the NEXT 7 days. Re-uses the same source so we don't
    // need a separate cron beat for the upcoming list.
    safe(sql.query(
      `SELECT COUNT(*)::int AS n
         FROM bookings
        WHERE workspace_id = $1
          AND cancelled_at IS NULL
          AND date >= CURRENT_DATE
          AND date <  CURRENT_DATE + INTERVAL '7 days'`,
      [workspaceId],
    ), { rows: [{ n: 0 }] }),
    // Revenue: invoices marked paid in the window. paid_at is set by
    // the Stripe webhook + the manual mark-paid endpoint.
    safe(sql`
      SELECT COALESCE(SUM(paid_amount), 0)::numeric AS total
        FROM invoices
       WHERE workspace_id = ${workspaceId}
         AND status = 'paid'
         AND paid_at >= ${fromIso}::timestamptz
         AND paid_at <  ${toIso}::timestamptz
    `, { rows: [{ total: 0 }] }),
    safe(sql`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0)::numeric AS total
        FROM invoices
       WHERE workspace_id = ${workspaceId}
         AND status = 'sent'
         AND due_date IS NOT NULL
         AND due_date < CURRENT_DATE
    `, { rows: [{ n: 0, total: 0 }] }),
  ]);

  return {
    newClients:           newClients.rows[0]?.n || 0,
    completedBookings:    completed.rows[0]?.n || 0,
    upcomingBookings:     upcoming.rows[0]?.n || 0,
    revenuePaid:          Number(revenue.rows[0]?.total || 0),
    overdueInvoiceCount:  overdue.rows[0]?.n || 0,
    overdueInvoiceTotal:  Number(overdue.rows[0]?.total || 0),
  };
}

// Owner snapshot — pulls profile + biz name in one query (mirroring
// loadOwner in subscriptionNotify).
async function loadOwner(workspaceId) {
  const { rows } = await sql`
    SELECT w.owner_id, u.email, u.name, cs.biz_name
      FROM workspaces w
      LEFT JOIN users u ON u.id = w.owner_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
     WHERE w.id = ${workspaceId}
  `;
  return rows[0] || null;
}

export async function notifyWeeklyRecap({ workspaceId, from, to }) {
  try {
    const o = await loadOwner(workspaceId);
    if (!o?.email) return { sent: false, reason: 'no-owner-email' };
    const stats = await buildStats({ workspaceId, from, to });
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
    return result;
  } catch (err) {
    console.error('[weeklyRecap] failed:', err.message);
    reportError(err, { extra: { workspaceId } });
    return { sent: false, reason: err.message };
  }
}
