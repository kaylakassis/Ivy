// The dashboard's "Key numbers": only numbers we compute correctly, each
// with an honest comparison or null when there is not enough history yet
// (the app then says "Not enough data yet" instead of a misleading 0%).
//
// Money uses the same rules as the Finance totals (api/finance/index.js):
// revenue is paid invoices only, total minus refunds, never below zero, so
// voided and fully refunded invoices count for nothing and a partial
// refund reduces the number. Outstanding is what is left on sent and
// overdue invoices after gift cards and part payments. Every window is in
// the owner's time zone. Every query is scoped to one workspace.
import { sql } from './db.js';

export const REBOOK_MIN_COHORT = 5;
export const REBOOK_WINDOW = { fromDays: 120, toDays: 30 };

export async function keyNumbers(workspaceId, tz = 'UTC') {
  const [rev, bk, nc, out, rb, ws] = await Promise.all([
    sql`
      WITH b AS (
        SELECT (NOW() AT TIME ZONE ${tz}) AS now_l,
               date_trunc('month', NOW() AT TIME ZONE ${tz}) AS m0,
               date_trunc('month', NOW() AT TIME ZONE ${tz}) - INTERVAL '1 month' AS m1,
               date_trunc('week', NOW() AT TIME ZONE ${tz}) AS w0,
               date_trunc('day', NOW() AT TIME ZONE ${tz}) AS d0
      ), inv AS (
        SELECT (paid_at AT TIME ZONE ${tz}) AS p, invoice_net_revenue(invoices) AS kept
          FROM invoices
         WHERE workspace_id = ${workspaceId} AND status = 'paid' AND paid_at IS NOT NULL
           AND paid_at >= NOW() - INTERVAL '70 days'
      )
      SELECT
        COALESCE(SUM(kept) FILTER (WHERE p >= b.m0), 0)::numeric AS this_month,
        COALESCE(SUM(kept) FILTER (WHERE p >= b.m1 AND p < LEAST(b.m1 + (b.now_l - b.m0), b.m0)), 0)::numeric AS last_month_same_point,
        COALESCE(SUM(kept) FILTER (WHERE p >= b.m1 AND p < b.m0), 0)::numeric AS last_month_total,
        COALESCE(SUM(kept) FILTER (WHERE p >= b.d0), 0)::numeric AS today,
        COALESCE(SUM(kept) FILTER (WHERE p >= b.w0), 0)::numeric AS week
        FROM b LEFT JOIN inv ON TRUE
       GROUP BY b.m0`,
    sql`
      SELECT
        COUNT(*) FILTER (WHERE date >= date_trunc('week', NOW() AT TIME ZONE ${tz})::date
                           AND date <  date_trunc('week', NOW() AT TIME ZONE ${tz})::date + 7)::int AS this_week,
        COUNT(*) FILTER (WHERE date >= date_trunc('week', NOW() AT TIME ZONE ${tz})::date - 7
                           AND date <  date_trunc('week', NOW() AT TIME ZONE ${tz})::date)::int AS last_week
        FROM bookings
       WHERE workspace_id = ${workspaceId} AND cancelled_at IS NULL
         AND date >= date_trunc('week', NOW() AT TIME ZONE ${tz})::date - 7
         AND date <  date_trunc('week', NOW() AT TIME ZONE ${tz})::date + 7`,
    sql`
      WITH b AS (
        SELECT (NOW() AT TIME ZONE ${tz}) AS now_l,
               date_trunc('month', NOW() AT TIME ZONE ${tz}) AS m0,
               date_trunc('month', NOW() AT TIME ZONE ${tz}) - INTERVAL '1 month' AS m1
      )
      SELECT
        COUNT(*) FILTER (WHERE (c.created_at AT TIME ZONE ${tz}) >= b.m0)::int AS this_month,
        COUNT(*) FILTER (WHERE (c.created_at AT TIME ZONE ${tz}) >= b.m1
                           AND (c.created_at AT TIME ZONE ${tz}) < LEAST(b.m1 + (b.now_l - b.m0), b.m0))::int AS last_month_same_point
        FROM b LEFT JOIN clients c
          ON c.workspace_id = ${workspaceId} AND c.stage <> 'lead'
         AND c.source IS DISTINCT FROM 'demo'
         AND c.created_at >= NOW() - INTERVAL '70 days'
       GROUP BY b.m0`,
    sql`
      WITH inv AS (
        SELECT status,
               GREATEST(total
                 - CASE WHEN paid_method = 'gift_card' THEN 0
                        ELSE GREATEST(gift_card_credit_cents - gift_card_credit_restored_cents, 0) / 100.0 END
                 - GREATEST(COALESCE(paid_amount, 0) - COALESCE(refunded_amount, 0), 0), 0) AS owed
          FROM invoices
         WHERE workspace_id = ${workspaceId} AND status IN ('sent', 'overdue')
      )
      SELECT COUNT(*)::int AS n, COALESCE(SUM(owed), 0)::numeric AS total,
             COUNT(*) FILTER (WHERE status = 'overdue')::int AS overdue_n,
             COALESCE(SUM(owed) FILTER (WHERE status = 'overdue'), 0)::numeric AS overdue_total
        FROM inv`,
    // Rebooking: clients whose first visit in the window (30 to 120 days
    // ago; cancelled and no-show visits do not count) and who booked again
    // after it, or are on a repeating booking still running past it.
    sql`
      WITH first_visit AS (
        SELECT b.client_id, MIN(b.date) AS d
          FROM bookings b
          JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
         WHERE b.workspace_id = ${workspaceId} AND b.cancelled_at IS NULL AND b.no_show_at IS NULL
           AND c.source IS DISTINCT FROM 'demo'
           AND b.date >= (NOW() AT TIME ZONE ${tz})::date - ${REBOOK_WINDOW.fromDays}::int
           AND b.date <  (NOW() AT TIME ZONE ${tz})::date - ${REBOOK_WINDOW.toDays}::int
         GROUP BY b.client_id
      )
      SELECT COUNT(*)::int AS cohort,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM bookings b2
                WHERE b2.workspace_id = ${workspaceId} AND b2.client_id = f.client_id
                  AND b2.cancelled_at IS NULL
                  AND (b2.date > f.d
                       OR (b2.recurrence_rule IS NOT NULL AND b2.date <= f.d
                           AND (b2.recurrence_until IS NULL OR b2.recurrence_until > f.d)))
             ))::int AS rebooked
        FROM first_visit f`,
    sql`
      SELECT (created_at AT TIME ZONE ${tz}) < date_trunc('month', NOW() AT TIME ZONE ${tz}) - INTERVAL '1 month' AS full_last_month,
             (created_at AT TIME ZONE ${tz}) < date_trunc('week', NOW() AT TIME ZONE ${tz}) - INTERVAL '7 days' AS full_last_week
        FROM workspaces WHERE id = ${workspaceId}`,
  ]);
  const r = rev.rows[0] || {};
  const w = ws.rows[0] || {};
  const n = (v) => Number(v || 0);
  const lastRev = n(r.last_month_same_point);
  const lastMonthKnown = !!w.full_last_month || n(r.last_month_total) > 0;
  const cohort = n(rb.rows[0]?.cohort);
  const rebooked = n(rb.rows[0]?.rebooked);
  return {
    revenue: {
      thisMonth: n(r.this_month),
      lastMonthSamePoint: lastMonthKnown ? lastRev : null,
      lastMonthTotal: lastMonthKnown ? n(r.last_month_total) : null,
      changePct: lastMonthKnown && lastRev > 0 ? Math.round(((n(r.this_month) - lastRev) / lastRev) * 100) : null,
    },
    bookingsWeek: {
      thisWeek: n(bk.rows[0]?.this_week),
      lastWeek: w.full_last_week || n(bk.rows[0]?.last_week) > 0 ? n(bk.rows[0]?.last_week) : null,
    },
    newClients: {
      thisMonth: n(nc.rows[0]?.this_month),
      lastMonthSamePoint: lastMonthKnown || n(nc.rows[0]?.last_month_same_point) > 0 ? n(nc.rows[0]?.last_month_same_point) : null,
    },
    outstanding: {
      count: n(out.rows[0]?.n), total: n(out.rows[0]?.total),
      overdueCount: n(out.rows[0]?.overdue_n), overdueTotal: n(out.rows[0]?.overdue_total),
    },
    rebooking: {
      rate: cohort >= REBOOK_MIN_COHORT ? Math.round((rebooked / cohort) * 100) : null,
      cohort, rebooked, minCohort: REBOOK_MIN_COHORT,
    },
    money: { today: n(r.today), week: n(r.week) },
  };
}
