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
import { ok, methodNotAllowed, serverError } from './_lib/json.js';

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
      sql`SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS v FROM invoices
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
                 s.name AS service_name
            FROM bookings b
            LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
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

    return ok(res, {
      currency,
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
