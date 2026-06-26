// /api/cron/refresh-admin-analytics — every 15 min.
//
// Computes the slow, date-independent rollups that /api/admin/analytics
// used to fire on EVERY pageview as 13+ parallel COUNT(*)s. Several of
// those are full-table scans (users, workspaces, invoices) — fine at
// today's scale, ruinous at 100K+ rows per table.
//
// Stores them in `admin_analytics_cache` keyed by 'totals' and
// 'platformImpact'. The analytics endpoint reads from this cache (with
// the freshness timestamp surfaced in the response) for the slow
// rollups, and still fires live queries for the date-range-dependent
// metrics (funnel cohorts, onboarding aggregates, churn-in-window,
// revenue-in-window) which can't be precomputed because the window
// changes per request.
//
// Idempotent on retry: an UPSERT keyed on `key` overwrites the previous
// snapshot. No backfill — the table is cache, not history.
import { sql } from '../_lib/db.js';
import { reportError } from '../_lib/monitoring.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';

// Mirror of the constant in /api/admin/analytics.js so the cached
// platformImpact aggregates use the same window the live endpoint
// historically did. Keep in sync if the live endpoint changes.
const PLATFORM_LOOKBACK_DAYS = 90;

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    await ensureSchemaApplied();

    // ─── Totals (date-independent counters) ────────────────────────
    // 7 counters from the live endpoint that don't move with the window.
    // Fire in parallel; the slowest dominates.
    const [
      usersRow, bizActiveRow, bizTrialRow,
      sponsoredRow, affiliateRow, clientOnlyRow,
      revenueAllRow,
    ] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM users`,
      sql`SELECT COUNT(*)::int AS n FROM workspaces WHERE subscription_status = 'active'`,
      sql`SELECT COUNT(*)::int AS n FROM workspaces
            WHERE subscription_status = 'trialing'
              AND trial_ends_at IS NOT NULL
              AND trial_ends_at > NOW()`,
      sql`SELECT COUNT(*)::int AS n FROM users WHERE user_type = 'sponsored'`,
      sql`SELECT COUNT(*)::int AS n FROM users WHERE user_type = 'affiliate'`,
      sql`SELECT COUNT(DISTINCT u.id)::int AS n
            FROM users u
            WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)
              AND EXISTS (SELECT 1 FROM clients c WHERE c.user_id = u.id)`,
      sql`SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
            FROM invoices WHERE status = 'paid'`,
    ]);

    const totals = {
      users:           usersRow.rows[0]?.n || 0,
      businessActive:  bizActiveRow.rows[0]?.n || 0,
      businessTrial:   bizTrialRow.rows[0]?.n || 0,
      sponsored:       sponsoredRow.rows[0]?.n || 0,
      affiliate:       affiliateRow.rows[0]?.n || 0,
      clientOnly:      clientOnlyRow.rows[0]?.n || 0,
      revenueAllTime:  Number(revenueAllRow.rows[0]?.total || 0),
    };

    // ─── Platform-impact aggregates (rolling 90d window) ───────────
    // The most expensive set: joins + group-bys across bookings,
    // invoices, workflows, ivy_sessions, reviews. Precomputing these
    // is the biggest win — admin pageview goes from 3-5 full-table
    // scans to one indexed read.
    const [
      bookingTotalsRow,
      completedBookingsRow,
      avgRevPerActiveRow,
      avgClientsPerActiveRow,
      avgBookingsPerActiveRow,
      workflowAdoptionRow,
      ivyAdoptionRow,
      reviewsRow,
      activationRow,
    ] = await Promise.all([
      sql.query(
        `SELECT
           COUNT(*)::int                                        AS total,
           COUNT(*) FILTER (WHERE no_show_at IS NOT NULL)::int  AS no_shows,
           COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS cancelled
           FROM bookings
          WHERE date >= CURRENT_DATE - ($1::int || ' days')::interval`,
        [PLATFORM_LOOKBACK_DAYS],
      ),
      sql.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE completion_log IS NOT NULL
               AND completion_log::text <> '{}'
           )::int AS completed,
           COUNT(*) FILTER (
             WHERE cancelled_at IS NULL
               AND no_show_at IS NULL
               AND date < CURRENT_DATE
           )::int AS past_attendable
           FROM bookings
          WHERE date >= CURRENT_DATE - ($1::int || ' days')::interval
            AND date < CURRENT_DATE`,
        [PLATFORM_LOOKBACK_DAYS],
      ),
      sql.query(
        `WITH active AS (
           SELECT COUNT(*)::int AS n FROM workspaces WHERE subscription_status = 'active'
         ),
         rev AS (
           SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
             FROM invoices
            WHERE status = 'paid'
              AND paid_at >= NOW() - ($1::int || ' days')::interval
         )
         SELECT
           (SELECT n FROM active) AS active_count,
           (SELECT total FROM rev) AS revenue`,
        [PLATFORM_LOOKBACK_DAYS],
      ),
      sql`
        WITH active_ws AS (
          SELECT id FROM workspaces WHERE subscription_status = 'active'
        ),
        counts AS (
          SELECT w.id, COUNT(c.id) AS n
            FROM active_ws w
            LEFT JOIN clients c ON c.workspace_id = w.id
           GROUP BY w.id
        )
        SELECT
          COALESCE(AVG(n)::numeric(12,2), 0) AS avg_clients,
          COUNT(*)::int                       AS denom
          FROM counts
      `,
      sql.query(
        `WITH active_ws AS (
           SELECT id FROM workspaces WHERE subscription_status = 'active'
         ),
         counts AS (
           SELECT w.id, COUNT(b.id) AS n
             FROM active_ws w
             LEFT JOIN bookings b
               ON b.workspace_id = w.id
              AND b.date >= CURRENT_DATE - ($1::int || ' days')::interval
            GROUP BY w.id
         )
         SELECT COALESCE(AVG(n)::numeric(12,2), 0) AS avg_bookings
           FROM counts`,
        [PLATFORM_LOOKBACK_DAYS],
      ),
      sql`
        SELECT
          (SELECT COUNT(DISTINCT workspace_id)::int
             FROM workflows
            WHERE enabled = TRUE
              AND workspace_id IN (SELECT id FROM workspaces WHERE subscription_status = 'active')
          ) AS adopters,
          (SELECT COUNT(*)::int FROM workspaces WHERE subscription_status = 'active') AS denom
      `,
      sql`
        SELECT
          (SELECT COUNT(DISTINCT workspace_id)::int
             FROM ivy_sessions
            WHERE workspace_id IN (SELECT id FROM workspaces WHERE subscription_status = 'active')
          ) AS adopters,
          (SELECT COUNT(*)::int FROM workspaces WHERE subscription_status = 'active') AS denom
      `,
      sql`
        SELECT
          COUNT(*)::int                       AS count,
          COALESCE(AVG(rating)::numeric(3,2), 0) AS avg_rating
          FROM reviews
         WHERE status = 'visible'
      `,
      sql.query(
        `WITH first_booking AS (
           SELECT b.workspace_id, MIN(b.created_at) AS first_at
             FROM bookings b
            GROUP BY b.workspace_id
         )
         SELECT
           (SELECT COUNT(*)::int FROM first_booking f
              JOIN workspaces w ON w.id = f.workspace_id
             WHERE f.first_at <= w.created_at + INTERVAL '7 days'
          ) AS activated,
          (SELECT COUNT(*)::int FROM workspaces WHERE created_at < NOW() - INTERVAL '7 days') AS eligible`,
      ),
    ]);

    // Derive the same ratio + per-active rollups the live endpoint
    // computes today. Identical math so the cache is a drop-in for the
    // formatted response shape.
    const bk = bookingTotalsRow.rows[0] || {};
    const bkTotal = bk.total || 0;
    const noShows = bk.no_shows || 0;
    const cancelledBk = bk.cancelled || 0;
    const noShowPct = bkTotal > 0 ? Math.round((noShows / bkTotal) * 1000) / 10 : 0;
    const cancellationPct = bkTotal > 0 ? Math.round((cancelledBk / bkTotal) * 1000) / 10 : 0;

    const comp = completedBookingsRow.rows[0] || {};
    const completedBk = comp.completed || 0;
    const pastAttendable = comp.past_attendable || 0;
    const completionPct = pastAttendable > 0
      ? Math.round((completedBk / pastAttendable) * 1000) / 10
      : 0;

    const arpw = avgRevPerActiveRow.rows[0] || {};
    const activeCount = arpw.active_count || 0;
    const lookbackRevenue = Number(arpw.revenue || 0);
    const avgRevenuePerActive = activeCount > 0
      ? Math.round((lookbackRevenue / activeCount) * 100) / 100
      : 0;
    const avgMonthlyRevenuePerActive = activeCount > 0
      ? Math.round((lookbackRevenue / activeCount / 3) * 100) / 100
      : 0;

    const avgClients = Number(avgClientsPerActiveRow.rows[0]?.avg_clients || 0);
    const avgBookings = Number(avgBookingsPerActiveRow.rows[0]?.avg_bookings || 0);

    const wfAdopt = workflowAdoptionRow.rows[0] || {};
    const wfAdoptionPct = (wfAdopt.denom || 0) > 0
      ? Math.round((wfAdopt.adopters / wfAdopt.denom) * 1000) / 10
      : 0;
    const ivyAdopt = ivyAdoptionRow.rows[0] || {};
    const ivyAdoptionPct = (ivyAdopt.denom || 0) > 0
      ? Math.round((ivyAdopt.adopters / ivyAdopt.denom) * 1000) / 10
      : 0;

    const reviews = reviewsRow.rows[0] || {};
    const reviewCount = reviews.count || 0;
    const avgRating = Number(reviews.avg_rating || 0);

    const act = activationRow.rows[0] || {};
    const activatedCount = act.activated || 0;
    const eligibleCount = act.eligible || 0;
    const activationPct = eligibleCount > 0
      ? Math.round((activatedCount / eligibleCount) * 1000) / 10
      : 0;

    const platformImpact = {
      lookbackDays:    PLATFORM_LOOKBACK_DAYS,
      bookingsCounted: bkTotal,
      noShowRatePct:   noShowPct,
      cancellationRatePct: cancellationPct,
      completionRatePct:   completionPct,
      avgRevenuePerActive,
      avgMonthlyRevenuePerActive,
      avgClientsPerActive: Math.round(avgClients * 10) / 10,
      avgBookingsPerActive90d: Math.round(avgBookings * 10) / 10,
      workflowAdoptionPct: wfAdoptionPct,
      ivyAdoptionPct,
      reviews: {
        count:     reviewCount,
        avgRating: Math.round(avgRating * 100) / 100,
      },
      activationPct,
      activatedCount,
      eligibleCount,
    };

    // Single UPSERT per key — keeps the cache table at exactly 2 rows.
    // ON CONFLICT updates the value + bumps computed_at so the endpoint
    // can compute freshness for the operator-facing badge.
    await sql`
      INSERT INTO admin_analytics_cache (key, value, computed_at)
      VALUES ('totals', ${JSON.stringify(totals)}::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, computed_at = NOW()
    `;
    await sql`
      INSERT INTO admin_analytics_cache (key, value, computed_at)
      VALUES ('platformImpact', ${JSON.stringify(platformImpact)}::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, computed_at = NOW()
    `;

    return ok(res, { ok: true, totalsKeys: Object.keys(totals).length, platformImpactKeys: Object.keys(platformImpact).length });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

export default trackCron('refresh-admin-analytics', handler);
