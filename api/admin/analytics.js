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

    // Cache reads first. The 7-key 'totals' rollup and the
    // platformImpact aggregates are date-INDEPENDENT, refreshed every
    // 15 min by api/cron/refresh-admin-analytics.js. Reading them from
    // a 2-row cache table replaces 13 of the parallel queries below
    // (including the worst offenders: full-table COUNT(*) on users +
    // workspaces, 90-day rolling joins across bookings + invoices). On
    // first deploy (or if the cron hasn't run yet) the cache rows are
    // absent — we fall back to live queries so the endpoint still
    // works, just at the old cost.
    const cacheRows = await sql`
      SELECT key, value, computed_at
        FROM admin_analytics_cache
       WHERE key IN ('totals', 'platformImpact')
    `;
    // Freshness: a cache older than 60s is treated as MISSING, so the
    // fallback live queries below run and the operator sees near-real-
    // time numbers ("it isn't updating" was the 15-min cron staleness).
    // Cost stays bounded at scale: at most one live recompute per 60s
    // per key - the cron remains the keep-warm for the common case.
    const CACHE_MAX_AGE_MS = 60 * 1000;
    const fresh = (key) => {
      const row = cacheRows.rows.find((r) => r.key === key);
      if (!row) return null;
      const age = Date.now() - new Date(row.computed_at).getTime();
      return age <= CACHE_MAX_AGE_MS ? row.value : null;
    };
    const cachedTotals = fresh('totals');
    const cachedPlatform = fresh('platformImpact');
    const cacheComputedAt = cacheRows.rows.length
      ? cacheRows.rows
          .map((r) => new Date(r.computed_at).getTime())
          .reduce((min, t) => Math.min(min, t), Infinity)
      : null;

    // Parallelize the WINDOW-DEPENDENT queries + a live fallback for
    // any cache key that's missing. Each query is independent.
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
      // or AVG across the active business base - no PII, no per-
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
      funnelRow,                // acquisition funnel cohort counts (signup→converted)
      funnelStepsRow,           // per-onboarding-step first-seen counts
      onbCountsRow,             // onboarding "About you": cohort + answered counts
      onbGoalRows,              // goal distribution
      onbChallengeRows,         // challenge distribution
      onbHeardRows,             // acquisition-channel distribution
      onbStageRows,             // business-stage distribution
    ] = await Promise.all([
      // ── Cached when available, live as a fallback. The fallback
      // queries are the original ones from the historical analytics
      // endpoint — kept verbatim so a missing cache row never breaks
      // the admin UI.
      cachedTotals
        ? { rows: [{ n: cachedTotals.users }] }
        : sql`SELECT COUNT(*)::int AS n FROM users`,
      sql.query(
        `SELECT COUNT(*)::int AS n FROM users WHERE created_at >= $1 AND created_at < $2`,
        [fromIso, toIso],
      ),
      cachedTotals
        ? { rows: [{ n: cachedTotals.businessActive }] }
        : sql`SELECT COUNT(*)::int AS n FROM workspaces WHERE subscription_status = 'active'`,
      cachedTotals
        ? { rows: [{ n: cachedTotals.businessTrial }] }
        : sql`SELECT COUNT(*)::int AS n FROM workspaces
                WHERE subscription_status = 'trialing'
                  AND trial_ends_at IS NOT NULL
                  AND trial_ends_at > NOW()`,
      cachedTotals
        ? { rows: [{ n: cachedTotals.sponsored }] }
        : sql`SELECT COUNT(*)::int AS n FROM users WHERE user_type = 'sponsored'`,
      cachedTotals
        ? { rows: [{ n: cachedTotals.affiliate }] }
        : sql`SELECT COUNT(*)::int AS n FROM users WHERE user_type = 'affiliate'`,
      cachedTotals
        ? { rows: [{ n: cachedTotals.clientOnly }] }
        : sql`SELECT COUNT(DISTINCT u.id)::int AS n
                FROM users u
                WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)
                  AND EXISTS (SELECT 1 FROM clients c WHERE c.user_id = u.id)`,
      cachedTotals
        ? { rows: [{ total: cachedTotals.revenueAllTime }] }
        : sql`SELECT COALESCE(SUM(total - COALESCE(refunded_amount, 0)), 0)::numeric AS total
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
      // Active denominator at start of window - best-effort proxy:
      // workspaces created before window start that are or were paying.
      sql.query(
        `SELECT COUNT(*)::int AS n FROM workspaces
          WHERE created_at < $1
            AND subscription_status IN ('active', 'past_due', 'trialing', 'cancelled')`,
        [fromIso],
      ),
      // ─── Marketing aggregates (90-day rolling window) ────────────
      // These are PLATFORM-WIDE, cross-tenant rollups (every workspace at
      // once), so the CURRENT_DATE windows here stay anchored to UTC on
      // purpose - there is no single "owner timezone" to convert to, and a
      // stable UTC boundary keeps the numbers comparable run-to-run.
      // (Per-workspace, owner-facing surfaces DO use the workspace tz.)
      //
      // Nine queries precomputed in api/cron/refresh-admin-analytics.js
      // and stored as the 'platformImpact' JSONB blob. When the cache
      // row is present we skip every one of these by short-circuiting
      // to a no-op promise; the response construction below detects the
      // cache and inlines `cachedPlatform` directly. When it's absent
      // (first deploy / cron hasn't run yet) the live queries run as
      // before so the endpoint never breaks.
      cachedPlatform ? Promise.resolve({ rows: [] }) : sql.query(
        `SELECT
           COUNT(*)::int                                    AS total,
           COUNT(*) FILTER (WHERE no_show_at IS NOT NULL)::int  AS no_shows,
           COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL)::int AS cancelled
           FROM bookings
          WHERE date >= CURRENT_DATE - ($1::int || ' days')::interval`,
        [PLATFORM_LOOKBACK_DAYS],
      ),
      cachedPlatform ? Promise.resolve({ rows: [] }) : sql.query(
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
      cachedPlatform ? Promise.resolve({ rows: [] }) : sql.query(
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
      cachedPlatform ? Promise.resolve({ rows: [] }) : sql`
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
      cachedPlatform ? Promise.resolve({ rows: [] }) : sql.query(
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
      cachedPlatform ? Promise.resolve({ rows: [] }) : sql`
        SELECT
          (SELECT COUNT(DISTINCT workspace_id)::int
             FROM workflows
            WHERE enabled = TRUE
              AND workspace_id IN (SELECT id FROM workspaces WHERE subscription_status = 'active')
          ) AS adopters,
          (SELECT COUNT(*)::int FROM workspaces WHERE subscription_status = 'active') AS denom
      `,
      cachedPlatform ? Promise.resolve({ rows: [] }) : sql`
        SELECT
          (SELECT COUNT(DISTINCT workspace_id)::int
             FROM ivy_sessions
            WHERE workspace_id IN (SELECT id FROM workspaces WHERE subscription_status = 'active')
          ) AS adopters,
          (SELECT COUNT(*)::int FROM workspaces WHERE subscription_status = 'active') AS denom
      `,
      cachedPlatform ? Promise.resolve({ rows: [] }) : sql`
        SELECT
          COUNT(*)::int                       AS count,
          COALESCE(AVG(rating)::numeric(3,2), 0) AS avg_rating
          FROM reviews
         WHERE status = 'visible'
      `,
      cachedPlatform ? Promise.resolve({ rows: [] }) : sql.query(
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
      // ─── Acquisition funnel (cohort = workspaces created in window) ──
      // Tracks how far each signup cohort progressed, regardless of WHEN
      // they reached each step. Five steps, all derived from columns that
      // are stamped once and never rewound:
      //   signup            → workspaces.created_at in [from,to)
      //   onboardingStarted → owner's users.onboarding_state shows progress
      //                       past the first screen
      //   onboardingDone    → workspaces.onboarded_at set
      //   paywallSeen       → workspaces.paywall_first_seen_at set (the
      //                       hard wall denied them at least once)
      //   converted         → workspaces.converted_at set (first paid)
      //
      // NOTE: paywall_first_seen_at + converted_at only began stamping
      // when the hard paywall shipped, so cohorts from before that deploy
      // under-report those two steps. Recent cohorts are accurate. The
      // onboarding step is best-effort: onboarding_state is JSONB and a
      // brand-new row may be '{}' (counts as not-started).
      sql.query(
        `WITH cohort AS (
           SELECT w.id, w.onboarded_at, w.paywall_first_seen_at,
                  w.trial_started_at, w.converted_at, w.subscription_source,
                  w.walkthrough_started_at, w.aha_cta_clicked_at, w.aha_cta_skipped_at,
                  u.onboarding_state
             FROM workspaces w
             LEFT JOIN users u ON u.id = w.owner_id
            WHERE w.created_at >= $1 AND w.created_at < $2
         )
         SELECT
           COUNT(*)::int AS signups,
           COUNT(*) FILTER (
             WHERE onboarding_state IS NOT NULL
               AND (
                 -- jsonb_array_length() raises if completedSteps is present
                 -- but not a JSON array (legacy/partial writes). Guard with
                 -- jsonb_typeof so one malformed row can't 500 the whole
                 -- analytics endpoint.
                 COALESCE(
                   CASE WHEN jsonb_typeof(onboarding_state->'completedSteps') = 'array'
                        THEN jsonb_array_length(onboarding_state->'completedSteps')
                        ELSE 0 END, 0) > 0
                 OR COALESCE(onboarding_state->>'currentStep', 'welcome') <> 'welcome'
               )
           )::int AS onboarding_started,
           COUNT(*) FILTER (WHERE onboarded_at IS NOT NULL)::int           AS onboarding_done,
           COUNT(*) FILTER (WHERE paywall_first_seen_at IS NOT NULL)::int  AS paywall_seen,
           -- trial_started: card-backed trial commit (Stripe trial-with-card
           -- on web, Apple intro offer on iOS). The funnel step between
           -- paywall_seen and converted that the video stresses.
           COUNT(*) FILTER (WHERE trial_started_at IS NOT NULL)::int       AS trial_started,
           COUNT(*) FILTER (WHERE converted_at IS NOT NULL)::int           AS converted,
           -- Platform split on trial starts so we can read iOS vs web
           -- conversion in isolation (Apple takes a 15-30% cut, so the
           -- mix matters for ARPU math).
           COUNT(*) FILTER (WHERE trial_started_at IS NOT NULL AND subscription_source = 'apple')::int AS trial_started_apple,
           COUNT(*) FILTER (WHERE trial_started_at IS NOT NULL AND subscription_source <> 'apple')::int AS trial_started_web,
           COUNT(*) FILTER (WHERE converted_at IS NOT NULL     AND subscription_source = 'apple')::int AS converted_apple,
           COUNT(*) FILTER (WHERE converted_at IS NOT NULL     AND subscription_source <> 'apple')::int AS converted_web,
           -- Aha-moment telemetry. walkthrough_started → reached the
           -- post-onboarding tour at all; aha_clicked → took the "Get my
           -- booking link" CTA; aha_skipped → bailed. Click-rate of
           -- aha_clicked / walkthrough_started is the "is the aha screen
           -- working" signal.
           COUNT(*) FILTER (WHERE walkthrough_started_at IS NOT NULL)::int AS walkthrough_started,
           COUNT(*) FILTER (WHERE aha_cta_clicked_at IS NOT NULL)::int     AS aha_cta_clicked,
           COUNT(*) FILTER (WHERE aha_cta_skipped_at IS NOT NULL)::int     AS aha_cta_skipped
           FROM cohort`,
        [fromIso, toIso],
      ),
      // Per-onboarding-step first-seen counts. The server stamps each
      // step's first-seen time into onboarding_state.stepTimestamps; we
      // count how many cohort users have a stamp for each step, so the
      // admin can see "how many got to 'about' but not 'services'".
      sql.query(
        `WITH cohort AS (
           SELECT u.onboarding_state
             FROM workspaces w
             LEFT JOIN users u ON u.id = w.owner_id
            WHERE w.created_at >= $1 AND w.created_at < $2
         ),
         steps(id) AS (
           VALUES ('welcome'), ('business'), ('about'), ('services'),
                  ('availability'), ('first_product'), ('payments'),
                  ('branding'), ('first_client'), ('website'),
                  ('tour'), ('done')
         )
         SELECT s.id AS step,
                (SELECT COUNT(*)::int FROM cohort c
                  WHERE c.onboarding_state IS NOT NULL
                    AND jsonb_typeof(c.onboarding_state->'stepTimestamps') = 'object'
                    AND c.onboarding_state->'stepTimestamps' ? s.id) AS reached
           FROM steps s`,
        [fromIso, toIso],
      ),
      // ─── Onboarding "About you" aggregates (cohort = signups in window) ──
      // Aggregate-only by design: we GROUP over the preset option ids and
      // never return per-workspace rows or the free-text answers. The
      // "other" bucket counts preset-null-with-free-text so the channel /
      // goal mix stays honest.
      sql.query(
        `SELECT
           COUNT(*)::int AS cohort,
           COUNT(*) FILTER (
             WHERE wp.goal IS NOT NULL OR wp.goal_other IS NOT NULL
                OR wp.challenge IS NOT NULL OR wp.challenge_other IS NOT NULL
                OR wp.ideal_client IS NOT NULL
                OR wp.heard_from IS NOT NULL OR wp.heard_from_other IS NOT NULL
                OR wp.stage IS NOT NULL
           )::int AS answered
           FROM workspaces w
           LEFT JOIN workspace_profile wp ON wp.workspace_id = w.id
          WHERE w.created_at >= $1 AND w.created_at < $2`,
        [fromIso, toIso],
      ),
      onbDist('goal', 'goal_other', fromIso, toIso),
      onbDist('challenge', 'challenge_other', fromIso, toIso),
      onbDist('heard_from', 'heard_from_other', fromIso, toIso),
      onbDist('stage', null, fromIso, toIso),
    ]);

    const cancelled = churnCancelledRow.rows[0]?.n || 0;
    const denom = churnActiveAtStartRow.rows[0]?.n || 0;
    const ratePct = denom > 0 ? Math.round((cancelled / denom) * 1000) / 10 : 0;

    // ── Marketing aggregates ─────────────────────────────────────────
    // When the cache is populated, the live queries above were skipped
    // (Promise.resolve({rows:[]})) and we use the cached shape
    // verbatim. When it's not, we derive from the live rows exactly
    // the way the historical endpoint did. The two branches produce
    // identical response shapes — same keys, same rounding, same null
    // semantics — so admin code reads one structure either way.
    const platformImpact = cachedPlatform || (() => {
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
      return {
        lookbackDays: PLATFORM_LOOKBACK_DAYS,
        bookingsCounted: bkTotal,
        noShowRatePct: noShowPct,
        cancellationRatePct: cancellationPct,
        completionRatePct: completionPct,
        avgRevenuePerActive,
        avgMonthlyRevenuePerActive,
        avgClientsPerActive: Math.round(avgClients * 10) / 10,
        avgBookingsPerActive90d: Math.round(avgBookings * 10) / 10,
        workflowAdoptionPct: wfAdoptionPct,
        ivyAdoptionPct,
        reviews: { count: reviewCount, avgRating: Math.round(avgRating * 100) / 100 },
        activationPct,
        activatedCount,
        eligibleCount,
      };
    })();

    // ── Acquisition funnel ───────────────────────────────────────────
    // Raw cohort counts; the UI computes step-to-step + overall rates so
    // the math is visible in one place. Every count is a subset of
    // `signups`, so the funnel is monotonically non-increasing by
    // construction (a converted workspace also has paywall_seen etc. -
    // except where a cohort predates the paywall deploy; see the query
    // comment).
    const fn = funnelRow.rows[0] || {};

    // Owner usage-recency (real DAU/WAU/MAU from last_active_at). Served from
    // the precomputed cache when present; otherwise computed live. Owner = a
    // user who owns a workspace.
    const activeOwners = (cachedTotals && cachedTotals.activeOwnersMonth != null)
      ? {
          day:   cachedTotals.activeOwnersDay || 0,
          week:  cachedTotals.activeOwnersWeek || 0,
          month: cachedTotals.activeOwnersMonth || 0,
        }
      : await (async () => {
          const [d, w, m] = await Promise.all([1, 7, 30].map((days) => sql.query(
            `SELECT COUNT(*)::int AS n FROM users u
               WHERE u.last_active_at >= NOW() - ($1::int || ' days')::interval
                 AND EXISTS (SELECT 1 FROM workspaces ws WHERE ws.owner_id = u.id)`,
            [days],
          )));
          return { day: d.rows[0]?.n || 0, week: w.rows[0]?.n || 0, month: m.rows[0]?.n || 0 };
        })();

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
        activeOwnersDay:   activeOwners.day,
        activeOwnersWeek:  activeOwners.week,
        activeOwnersMonth: activeOwners.month,
      },
      churn: {
        cancelledInWindow:   cancelled,
        activeAtWindowStart: denom,
        ratePct,
      },
      // Marketing-friendly platform aggregates. All values are means
      // or ratios across active workspaces - no per-workspace data
      // leaves this endpoint. Safe to drop into landing copy ("Ivy
      // users see an average no-show rate of X%"). Window: 90d rolling.
      // Served from the analytics-cache table (refreshed every 15 min)
      // when the cron has populated it; otherwise computed live as a
      // fallback. cacheComputedAt is the freshness signal — when null
      // the values are real-time, when set it's the cache age.
      platformImpact,
      cacheComputedAt: cacheComputedAt && Number.isFinite(cacheComputedAt)
        ? new Date(cacheComputedAt).toISOString()
        : null,
      // Acquisition funnel for the selected window's signup cohort.
      // Counts only - the UI renders the bars + computes the conversion
      // and drop-off percentages.
      funnel: {
        signups:           fn.signups || 0,
        onboardingStarted: fn.onboarding_started || 0,
        onboardingDone:    fn.onboarding_done || 0,
        paywallSeen:       fn.paywall_seen || 0,
        trialStarted:      fn.trial_started || 0,
        converted:         fn.converted || 0,
        // Platform mix (Apple vs web) on the two billing-driven steps,
        // for "where are paying users coming from" reads.
        byPlatform: {
          trialStartedApple: fn.trial_started_apple || 0,
          trialStartedWeb:   fn.trial_started_web || 0,
          convertedApple:    fn.converted_apple || 0,
          convertedWeb:      fn.converted_web || 0,
        },
        // Per-onboarding-step first-seen counts (where in the wizard
        // owners drop off). [{ step, reached }].
        steps: funnelStepsRow.rows.map((r) => ({ step: r.step, reached: Number(r.reached) || 0 })),
        // Aha-moment funnel: of the cohort that finished onboarding and
        // opened the walkthrough, how many took the "Get my booking
        // link" CTA vs skipped it. Drives the activation metric below.
        aha: {
          walkthroughStarted: fn.walkthrough_started || 0,
          ctaClicked:         fn.aha_cta_clicked || 0,
          ctaSkipped:         fn.aha_cta_skipped || 0,
        },
      },
      // Onboarding "About you" answer distributions (aggregate only -
      // no per-workspace data, no free text). Each list is [{k, n}]
      // sorted by frequency; the UI maps option ids → labels + bars.
      onboarding: {
        cohort:    onbCountsRow.rows[0]?.cohort || 0,
        answered:  onbCountsRow.rows[0]?.answered || 0,
        goal:      onbGoalRows.rows.map((r) => ({ k: r.k, n: r.n })),
        challenge: onbChallengeRows.rows.map((r) => ({ k: r.k, n: r.n })),
        heardFrom: onbHeardRows.rows.map((r) => ({ k: r.k, n: r.n })),
        stage:     onbStageRows.rows.map((r) => ({ k: r.k, n: r.n })),
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}

// Distribution query for one onboarding preset field. `field` /
// `otherField` are internal literals (allowlisted below - never user
// input), so interpolating them as column names is safe. When otherField
// is given, preset-null-with-free-text rows collapse into an 'other'
// bucket so the mix stays honest.
function onbDist(field, otherField, fromIso, toIso) {
  const ALLOWED = new Set([
    'goal', 'challenge', 'heard_from', 'stage',
    'goal_other', 'challenge_other', 'heard_from_other',
  ]);
  if (!ALLOWED.has(field) || (otherField && !ALLOWED.has(otherField))) {
    throw new Error('onbDist: unrecognized field');
  }
  const keyExpr = otherField
    ? `COALESCE(wp.${field}, CASE WHEN wp.${otherField} IS NOT NULL THEN 'other' END)`
    : `wp.${field}`;
  return sql.query(
    `SELECT ${keyExpr} AS k, COUNT(*)::int AS n
       FROM workspace_profile wp
       JOIN workspaces w ON w.id = wp.workspace_id
      WHERE w.created_at >= $1 AND w.created_at < $2
        AND ${keyExpr} IS NOT NULL
      GROUP BY 1
      ORDER BY n DESC`,
    [fromIso, toIso],
  );
}

function parseDate(raw, fallback) {
  if (!raw) return fallback;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}
