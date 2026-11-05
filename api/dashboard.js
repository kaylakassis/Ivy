// GET /api/dashboard - the owner home rollup. Previously the dashboard
// rendered hardcoded "-" cards and empty panels; this returns the real
// numbers (this-month revenue, active clients, bookings, hours), today's
// schedule, a recent-activity feed, and open tasks, all workspace-scoped.
import { sql } from './_lib/db.js';
import { requireUser, ensureWorkspace } from './_lib/auth.js';
import { listTasksWithProgress, listGoalsWithProgress } from './_lib/goals.js';
import { workspaceTimeZone } from './_lib/calendar.js';
import { touchStreak } from './_lib/streak.js';
import { detectWorkflowSuggestion } from './_lib/workflowSuggest.js';
import { buildBriefing } from './_lib/ivy.js';
import { buildWeekStats, recapHasActivity, recapIvyRows, ivyTaskCount, timeSavedMinutes, MINUTES_PER_IVY_TASK } from './_lib/weeklyRecap.js';
import { firstWinForDashboard } from './_lib/firstWin.js';
import { computeSignals, publicItem, isSnoozedToday, readPartnerSettings } from './_lib/accountability.js';
import { keyNumbers } from './_lib/dashboardNumbers.js';
import { ok, methodNotAllowed, serverError } from './_lib/json.js';

const TWO_STEP_PROMPT_AFTER_DAYS = 3;

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    // All "today"/"this month" windows below are anchored to the owner's
    // timezone, not the server's UTC. tz is always a valid name ('UTC' fallback).
    const tz = await workspaceTimeZone(workspaceId);

    // Move finance_settings into the parallel batch — was sequential
    // (an extra round-trip per dashboard load) for no reason. 10
    // parallel reads with the same connection pool finish in roughly
    // the time of the slowest single one.
    const [rev, cli, booked, hours, exp, today, recentInv, recentBk, taskRows, fsRow] = await Promise.all([
      // Same revenue rule as Finance: paid only, minus refunds, never below 0.
      sql`SELECT COALESCE(SUM(GREATEST(total - COALESCE(refunded_amount, 0), 0)), 0)::numeric AS v FROM invoices
           WHERE workspace_id = ${workspaceId} AND status = 'paid'
             AND paid_at >= date_trunc('month', NOW() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}`,
      sql`SELECT COUNT(*)::int AS v FROM clients
           WHERE workspace_id = ${workspaceId} AND stage = 'active'`,
      sql`SELECT COUNT(*)::int AS v FROM bookings
           WHERE workspace_id = ${workspaceId} AND cancelled_at IS NULL
             AND date >= (date_trunc('month', NOW() AT TIME ZONE ${tz}))::date
             AND date <  (date_trunc('month', NOW() AT TIME ZONE ${tz}) + INTERVAL '1 month')::date`,
      sql`SELECT COALESCE(SUM(end_min - start_min), 0)::int AS m FROM bookings
           WHERE workspace_id = ${workspaceId} AND cancelled_at IS NULL
             AND date >= (date_trunc('month', NOW() AT TIME ZONE ${tz}))::date
             AND date <  (date_trunc('month', NOW() AT TIME ZONE ${tz}) + INTERVAL '1 month')::date`,
      sql`SELECT COALESCE(SUM(amount), 0)::numeric AS v FROM expenses
           WHERE workspace_id = ${workspaceId} AND date >= (date_trunc('month', NOW() AT TIME ZONE ${tz}))::date`,
      sql`SELECT b.id, b.start_min, b.end_min, b.client_name, b.no_show_at, b.completion_log,
                 b.client_id, b.video_room_url, b.date::text AS date,
                 s.name AS service_name, t.id AS thread_id
            FROM bookings b
            LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
            LEFT JOIN message_threads t ON t.client_id = b.client_id AND t.workspace_id = b.workspace_id
           WHERE b.workspace_id = ${workspaceId} AND b.date = (NOW() AT TIME ZONE ${tz})::date
             AND b.cancelled_at IS NULL
           ORDER BY b.start_min ASC LIMIT 20`,
      sql`SELECT number, client_name, paid_at FROM invoices
           WHERE workspace_id = ${workspaceId} AND status = 'paid' AND paid_at IS NOT NULL
           ORDER BY paid_at DESC LIMIT 6`,
      sql`SELECT client_name, created_at FROM bookings
           WHERE workspace_id = ${workspaceId}
           ORDER BY created_at DESC LIMIT 6`,
      listTasksWithProgress(workspaceId, 'false'),
      sql`SELECT currency FROM finance_settings WHERE workspace_id = ${workspaceId}`,
    ]);

    const currency = fsRow.rows[0]?.currency || 'USD';

    // Started now so they run alongside the reads below.
    const extrasP = Promise.all([
      Promise.all([
        computeSignals(workspaceId, { tz }),
        isSnoozedToday(workspaceId, tz),
        readPartnerSettings(user.id),
      ]).then(([items, snoozedToday, partner]) => ({
        items: items.slice(0, 12).map(publicItem), total: items.length, snoozedToday, partnerOn: partner.enabled,
      })).catch(() => null),
      keyNumbers(workspaceId, tz).catch(() => null),
    ]);

    // Merge a small recent-activity feed (newest first).
    const activity = [
      ...recentInv.rows.map((r) => ({
        kind: 'payment', ts: r.paid_at,
        text: `${r.client_name || 'A client'} paid ${r.number}`,
      })),
      ...recentBk.rows.map((r) => ({
        kind: 'booking', ts: r.created_at,
        text: `New booking - ${r.client_name || 'client'}`,
      })),
    ].filter((a) => a.ts)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 8)
      .map((a) => ({ ...a, ts: a.ts instanceof Date ? a.ts.toISOString() : a.ts }));

    // Advance the daily-return streak (the dashboard is the canonical daily
    // surface). Idempotent within a day; never blocks the load.
    const streak = await touchStreak(workspaceId);

    // "Ivy noticed a pattern" — suggest automating a repeated new-client
    // follow-up. Best-effort; skips ones the owner has dismissed.
    const workflowSuggestion = await detectWorkflowSuggestion(workspaceId, {
      dismissed: user.ui_prefs?.dismissedWorkflowSuggestions || [],
    });

    // Goal momentum on the home surface — the highest-intent retention object,
    // which otherwise only lived on /goals. Best-effort; [] on any hiccup.
    const goals = await listGoalsWithProgress(workspaceId, { limit: 3 });

    // "Today with Ivy" — surface the same deterministic briefing items (today's
    // sessions / unpaid invoices / quiet clients, each a tap-to-act Ivy prompt)
    // that live in the Ivy dock, on the highest-traffic surface. Reuse the goals
    // we just fetched + the streak from touchStreak so buildBriefing doesn't
    // re-read them. Best-effort: a briefing hiccup must never break the dashboard.
    let briefing = null;
    try {
      const b = await buildBriefing(workspaceId, { goals, streak });
      if (b?.items?.length) briefing = { items: b.items };
    } catch { /* no "today" card this load */ }

    // "This week": the same numbers the Monday recap email carries (last 7
    // days, rolling), so the card and the email never disagree. null when
    // nothing happened, which hides the card. Best-effort.
    let week = null;
    try {
      const to = new Date();
      const from = new Date(Date.now() - 7 * 86400000);
      const stats = await buildWeekStats({ workspaceId, from, to });
      if (recapHasActivity(stats)) {
        week = {
          from: from.toISOString(), to: to.toISOString(),
          bookingsTaken: stats.bookingsTaken,
          completedBookings: stats.completedBookings,
          revenuePaid: stats.revenuePaid,
          outstandingTotal: stats.outstandingTotal,
          newClients: stats.newClients,
          ivyRows: recapIvyRows(stats),
          ivyTasks: ivyTaskCount(stats),
          timeSavedMinutes: timeSavedMinutes(stats),
          minutesPerTask: MINUTES_PER_IVY_TASK,
          upcomingBookings: stats.upcomingBookings,
          overdueInvoiceCount: stats.overdueInvoiceCount,
          overdueInvoiceTotal: stats.overdueInvoiceTotal,
        };
      }
    } catch { /* no "this week" card this load */ }

    // First win: whether to show the "Your business is ready" cards (a new
    // owner's first dashboard visit) and any one-time first-booking /
    // first-payment moment waiting to be shown. Never throws.
    const firstWin = await firstWinForDashboard(workspaceId);

    // Upcoming appointments (next 7 days, business time zone) whose client
    // has no email: those clients get no reminder. Counted per client so
    // the dashboard can say "3 clients" and link to the Missing email list.
    let missingEmail = { clients: 0, appointments: 0 };
    try {
      const me = await sql`
        SELECT COUNT(DISTINCT b.client_id)::int AS clients, COUNT(*)::int AS appointments
          FROM bookings b JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
         WHERE b.workspace_id = ${workspaceId} AND b.cancelled_at IS NULL
           AND (c.email IS NULL OR c.email = '')
           AND b.date >= (NOW() AT TIME ZONE ${tz})::date
           AND b.date <  (NOW() AT TIME ZONE ${tz})::date + 7`;
      missingEmail = { clients: me.rows[0]?.clients || 0, appointments: me.rows[0]?.appointments || 0 };
    } catch { /* card simply does not show */ }

    // "Turn on 2-step verification" nudge: once the owner has used Ivy for a
    // few days or connected card payments, until they turn it on or dismiss
    // it (ui_prefs.twoStepPromptDismissedAt, per user).
    let twoStepPrompt = false;
    try {
      if (!user.totp_enrolled_at && !user.mfa_email_enabled_at && !user.ui_prefs?.twoStepPromptDismissedAt) {
        const ageDays = (Date.now() - new Date(user.created_at).getTime()) / 86400000;
        if (ageDays >= TWO_STEP_PROMPT_AFTER_DAYS) twoStepPrompt = true;
        else {
          const fs = await sql`
            SELECT stripe_secret_encrypted, stripe_connect_user_id, stripe_onboarding_status
              FROM finance_settings WHERE workspace_id = ${workspaceId}`;
          const f = fs.rows[0] || {};
          twoStepPrompt = !!f.stripe_secret_encrypted
            || (!!f.stripe_connect_user_id && f.stripe_onboarding_status === 'complete');
        }
      }
    } catch { /* no nudge this load */ }

    // "Switching from another app?" card: a new-looking book (fewer than 3
    // real clients, no bookings at all, sample data ignored) gets a nudge to
    // bring their clients over. Dismissed on the device. Best-effort.
    let switchPrompt = false;
    try {
      const sp = await sql`
        SELECT
          (SELECT COUNT(*)::int FROM (
             SELECT 1 FROM clients
              WHERE workspace_id = ${workspaceId} AND source IS DISTINCT FROM 'demo'
              LIMIT 3) x) AS clients,
          EXISTS (
            SELECT 1 FROM bookings b
              LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
             WHERE b.workspace_id = ${workspaceId} AND b.cancelled_at IS NULL
               AND c.source IS DISTINCT FROM 'demo') AS has_bookings`;
      const row = sp.rows[0] || {};
      switchPrompt = (row.clients || 0) < 3 && !row.has_bookings;
    } catch { /* no card this load */ }

    // 1.0.6: the accountability partner's "Needs your attention" list (the
    // same signals its messages use), the key numbers with honest
    // comparisons, and money in today / this week. All additive: every
    // field above stays for the iPhone 1.0.5 dashboard. Best-effort each.
    // (started in parallel near the top of the handler)
    const [attention, numbers] = await extrasP;

    return ok(res, {
      currency,
      attention,
      keyNumbers: numbers ? {
        revenue: numbers.revenue, bookingsWeek: numbers.bookingsWeek, newClients: numbers.newClients,
        outstanding: numbers.outstanding, rebooking: numbers.rebooking,
        expensesThisMonth: Number(exp.rows[0].v || 0),
      } : null,
      money: numbers ? numbers.money : null,
      week,
      twoStepPrompt,
      switchPrompt,
      firstWin,
      missingEmail,
      streak: { days: streak.days, best: streak.best, milestone: streak.milestone },
      workflowSuggestion,
      briefing,
      goals,
      metrics: {
        mrr:     Number(rev.rows[0].v || 0),
        clients: Number(cli.rows[0].v || 0),
        booked:  Number(booked.rows[0].v || 0),
        hours:   Math.round((Number(hours.rows[0].m || 0) / 60) * 10) / 10,
      },
      revenueVsExpenses: {
        revenue:  Number(rev.rows[0].v || 0),
        expenses: Number(exp.rows[0].v || 0),
      },
      today: today.rows.map((r) => ({
        id: r.id, startMin: r.start_min, endMin: r.end_min,
        clientName: r.client_name, serviceName: r.service_name,
        noShow: !!r.no_show_at,
        completed: !!(r.completion_log && Object.keys(r.completion_log).length),
        // 1.0.6 (additive): for the Message / Start / Complete buttons.
        clientId: r.client_id || null, threadId: r.thread_id || null,
        videoUrl: r.video_room_url || null, date: r.date,
      })),
      tasks: (taskRows || []).slice(0, 6).map((t) => ({
        id: t.id, title: t.title, type: t.type,
        dueDate: t.due_date instanceof Date ? t.due_date.toISOString().slice(0, 10) : t.due_date,
        progress: t.progress,
      })),
      activity,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
