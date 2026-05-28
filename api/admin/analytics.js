// GET /api/admin/analytics?from=ISO&to=ISO
//
// Single round-trip with parallel sub-queries, so the admin overview
// loads fast even when the user picks "all time" against a sizeable
// users table. All counters are inclusive on `from`, exclusive on `to`.
//
// Response shape:
//   {
//     range: { from, to },
//     totals: {
//       users: <count of distinct users.id, dedupes business+client>,
//       newSignups: <users.created_at within window>,
//       businessActive: <workspaces.subscription_status='active'>,
//       businessTrial:  <workspaces.subscription_status='trialing' AND trial_ends_at>NOW()>,
//       sponsored:      <users.user_type='sponsored'>,
//       affiliate:      <users.user_type='affiliate'>,
//       clientOnly:     <users without a workspace, who claim 1+ clients rows>,
//       revenueAllTime: <sum paid invoices, all platforms>,
//       revenueWindow:  <same, within window>,
//     },
//     churn: {
//       cancelledInWindow,
//       activeAtWindowStart,
//       ratePct,
//     }
//   }
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const fromRaw = (req.query.from || '').toString();
    const toRaw   = (req.query.to   || '').toString();
    const fromIso = parseDate(fromRaw, '1970-01-01T00:00:00Z');
    const toIso   = parseDate(toRaw, new Date().toISOString());
    if (!fromIso || !toIso) return badRequest(res, 'Invalid from/to');

    // Platform-impact aggregates use a rolling 90-day window so a
    // "no-show rate" claim is current rather than diluted by years of
    // legacy data. Computed in addition to the user-supplied [from,to]
    // window which still drives signups + revenue.
    const PLATFORM_LOOKBACK_DAYS = 90;

    // Parallelize. Each query is independent.
    const [
      usersRow,
      signupsRow,
      bizActiveRow,
      bizTrialRow,
      sponsoredRow,
      affiliateRow,
      clientOnlyRow,
      revenueAllRow,
      revenueWindowRow,
      churnCancelledRow,
      churnActiveAtStartRow,
      // Marketing-grade aggregates. Every number here is a sum, count,
      // or AVG across the active business base — no PII, no per-
      // workspace identifying fields. Safe to use in landing copy
      // ("Average no-show rate is X%") with privacy intact.
      bookingTotalsRow,         // total bookings + no-shows + cancelled, last 90d
      completedBookingsRow,     // bookings with a completion_log entry, last 90d
      avgRevPerActiveRow,       // sum(paid_amount last 90d) / count(active workspaces)
      avgClientsPerActiveRow,   // mean of count(clients) per active workspace
      avgBookingsPerActiveRow,  // mean of count(bookings last 90d) per active workspace
      workflowAdoptionRow,      // workspaces with >=1 enabled workflow
      ivyAdoptionRow,           // workspaces with >=1 ivy_sessions row
      reviewsRow,               // count + avg rating
      activationRow,            // workspaces that took their first booking within 7d of signup
    ] = await Promise.all([
      sql`SELECT COUNT(*)::int AS n FROM users`,
      sql.query(
        `SELECT COUNT(*)::int AS n FROM users WHERE created_at >= $1 AND created_at < $2`,
        [fromIso, toIso],
      ),
      sql`SELECT COUNT(*)::int AS n FROM workspaces WHERE subscription_status = 'active'`,
      sql`SELECT COUNT(*)::int AS n FROM workspaces
            WHERE subscription_status = 'trialing'
              AND trial_ends_at IS NOT NULL
              AND trial_ends_at > NOW()`,
      sql`SELECT COUNT(*)::int AS n FROM users WHERE user_type = 'sponsored'`,
      sql`SELECT COUNT(*)::int AS n FROM users WHERE user_type = 'affiliate'`,
      // "Client-only" — users who don't own a workspace but DO have at
      // least one clients row claimed under their user_id. Avoids
      // counting bare auth records that haven't been linked anywhere.
      sql`SELECT COUNT(DISTINCT u.id)::int AS n
            FROM users u
            WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)
              AND EXISTS (SELECT 1 FROM clients c WHERE c.user_id = u.id)`,
      sql`SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
          FROM invoices WHERE status = 'paid'`,
      sql.query(
        `SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
          FROM invoices
          WHERE status = 'paid' AND paid_at >= $1 AND paid_at < $2`,
        [fromIso, toIso],
      ),
      // Churn in the window: count of workspaces that flipped to
      // 'cancelled' (we don't track the moment of state change yet so
      // approximate via subscription_period_end falling inside the window
      // for cancelled rows).
      sql.query(
        `SELECT COUNT(*)::int AS n FROM workspaces
          WHERE subscription_status = 'cancelled'
            AND subscription_period_end >= $1
            AND subscription_period_end < $2`,
        [fromIso, toIso],
      ),
      // Active denominator at start of window — best-effort proxy:
      // workspaces created before window start that are or were paying.
      sql.query(
        `SELECT COUNT(*)::int AS n FROM workspaces
          WHERE created_at < $1
            AND subscription_status IN ('active', 'past_due', 'trialing', 'cancelled')`,
        [fromIso],
      ),
      // ─── Marketing aggregates (90-day rolling window) ────────────
      // No-show + cancellation + total in one pass for ratio math.
      sql.query(
        `SELECT
           COUNT(*)::int                                    AS total,
           COUNT(*) FILTER (WHERE no_show_at IS NOT NULL)::int  AS no_shows,
           COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS cancelled
           FROM bookings
          WHERE date >= CURRENT_DATE - ($1::int || ' days')::interval`,
        [PLATFORM_LOOKBACK_DAYS],
      ),
      // Completed bookings via completion_log JSONB — any key present
      // counts the booking once. Denominator = past bookings that weren't
      // cancelled or no-show'd. Compares completed vs unattended.
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
      // Average revenue per ACTIVE workspace (paid invoices in window /
      // count of currently-active workspaces). Honest baseline number.
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
           (SELECT total FROM rev) AS revenue
        `,
        [PLATFORM_LOOKBACK_DAYS],
      ),
      // Average client base size per active workspace.
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
      // Average booking count (last 90d) per active workspace.
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
      // % of active workspaces with at least one enabled workflow.
      sql`
        SELECT
          (SELECT COUNT(DISTINCT workspace_id)::int
             FROM workflows
            WHERE enabled = TRUE
              AND workspace_id IN (SELECT id FROM workspaces WHERE subscription_status = 'active')
          ) AS adopters,
          (SELECT COUNT(*)::int FROM workspaces WHERE subscription_status = 'active') AS denom
      `,
      // % of active workspaces that have engaged with Ivy (>=1 session).
      sql`
        SELECT
          (SELECT COUNT(DISTINCT workspace_id)::int
             FROM ivy_sessions
            WHERE workspace_id IN (SELECT id FROM workspaces WHERE subscription_status = 'active')
          ) AS adopters,
          (SELECT COUNT(*)::int FROM workspaces WHERE subscription_status = 'active') AS denom
      `,
      // Aggregate review count + average rating (live published reviews).
      sql`
        SELECT
          COUNT(*)::int                       AS count,
          COALESCE(AVG(rating)::numeric(3,2), 0) AS avg_rating
          FROM reviews
         WHERE status = 'visible'
      `,
      // Activation rate: workspaces that took their first booking within
      // 7 days of signup. Strong product-market-fit signal.
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
          (SELECT COUNT(*)::int FROM workspaces WHERE created_at < NOW() - INTERVAL '7 days') AS eligible
        `,
      ),
    ]);

    const cancelled = churnCancelledRow.rows[0]?.n || 0;
    const denom = churnActiveAtStartRow.rows[0]?.n || 0;
    const ratePct = denom > 0 ? Math.round((cancelled / denom) * 1000) / 10 : 0;

    // ── Marketing aggregates ─────────────────────────────────────────
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
    // 90-day window → divide by 3 to get monthly approximation.
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

    return ok(res, {
      range: { from: fromIso, to: toIso },
      totals: {
        users:           usersRow.rows[0]?.n || 0,
        newSignups:      signupsRow.rows[0]?.n || 0,
        businessActive:  bizActiveRow.rows[0]?.n || 0,
        businessTrial:   bizTrialRow.rows[0]?.n || 0,
        sponsored:       sponsoredRow.rows[0]?.n || 0,
        affiliate:       affiliateRow.rows[0]?.n || 0,
        clientOnly:      clientOnlyRow.rows[0]?.n || 0,
        revenueAllTime:  Number(revenueAllRow.rows[0]?.total || 0),
        revenueWindow:   Number(revenueWindowRow.rows[0]?.total || 0),
      },
      churn: {
        cancelledInWindow:   cancelled,
        activeAtWindowStart: denom,
        ratePct,
      },
      // Marketing-friendly platform aggregates. All values are means
      // or ratios across active workspaces — no per-workspace data
      // leaves this endpoint. Safe to drop into landing copy ("THRYVE
      // users see an average no-show rate of X%"). Window: 90d rolling.
      platformImpact: {
        lookbackDays:    PLATFORM_LOOKBACK_DAYS,
        bookingsCounted: bkTotal,
        noShowRatePct:   noShowPct,
        cancellationRatePct: cancellationPct,
        completionRatePct:   completionPct,
        avgRevenuePerActive: avgRevenuePerActive,        // 90-day total ÷ active count
        avgMonthlyRevenuePerActive: avgMonthlyRevenuePerActive,
        avgClientsPerActive: Math.round(avgClients * 10) / 10,
        avgBookingsPerActive90d: Math.round(avgBookings * 10) / 10,
        workflowAdoptionPct: wfAdoptionPct,
        ivyAdoptionPct,
        reviews: {
          count:     reviewCount,
          avgRating: Math.round(avgRating * 100) / 100,
        },
        activationPct,    // signup → first booking within 7 days
        activatedCount,
        eligibleCount,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}

function parseDate(raw, fallback) {
  if (!raw) return fallback;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}
