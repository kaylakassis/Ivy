// Nightly retention sweep. Trims rows that are operationally useless
// past a certain age - keeps hot indexes from getting fat at scale.
//
// What gets pruned, why:
//   webhook_event_dedup    > 90 days  - providers don't retry past
//                                       3 days (Stripe), 24h (Square),
//                                       25h (PayPal). 90 = wide buffer.
//   daily_usage_counters   > 90 days  - historical counts useful for
//                                       admin dashboard charts (~3
//                                       months) but not forever.
//   workflow_runs          > 180 days - keeps recent debugging /
//                                       audit context, prunes the
//                                       long tail. workflow_steps
//                                       cascade.
//   rate_limits            > 7 days   - sliding-window rate-limiter
//                                       only ever reads the LAST
//                                       window's worth of rows.
//   notifications          > 60 days  - the bell feed only renders the
//                                       recent 50; older rows are dead
//                                       weight (grows unbounded otherwise).
//   ivy_usage              > 90 days  - per-workspace/day token counters;
//                                       ~3 months is plenty for admin
//                                       charts + the global cap roll-up.
//
// Each table is independent - a failure on one shouldn't abort the
// others. Per-table try/catch with reportError on failure.
//
// Caps DELETE batches so the cron stays within the function-time
// limit even if a backlog has accumulated (catch-up over many
// nightly runs is fine).
import { sql } from '../_lib/db.js';
import { reportError } from '../_lib/monitoring.js';
import { methodNotAllowed, ok, serverError, unauthorized } from '../_lib/json.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { trackCron } from '../_lib/cronMetrics.js';

const BATCH_LIMIT = 5000;

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  // Auth: Vercel Cron (Bearer CRON_SECRET), an admin secret, or a
  // signed-in super-admin. This endpoint runs destructive DELETEs, so it
  // must never be reachable unauthenticated.
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    const t0 = Date.now();
    const results = {};

    results.webhookDedup = await prune('webhook_event_dedup',
      `processed_at < NOW() - INTERVAL '90 days'`);

    results.usageCounters = await prune('daily_usage_counters',
      `day < CURRENT_DATE - 90`);

    results.workflowRuns = await prune('workflow_runs',
      `triggered_at < NOW() - INTERVAL '180 days'`);

    results.rateLimits = await prune('rate_limits',
      `attempted_at < NOW() - INTERVAL '7 days'`);

    // In-app bell feed. The reader (api/me/notification-feed.js) only ever
    // shows the recent 50; anything 60+ days old is unreachable weight and the
    // table otherwise grows without bound.
    results.notifications = await prune('notifications',
      `created_at < NOW() - INTERVAL '60 days'`);

    // Per-workspace/day Ivy token counters. ~3 months covers admin usage
    // charts and the global-spend roll-up; older rows just bloat the table.
    results.ivyUsage = await prune('ivy_usage',
      `day < CURRENT_DATE - 90`);

    results.cronRuns = await prune('cron_runs',
      `finished_at IS NOT NULL AND finished_at < NOW() - INTERVAL '30 days'`);

    // Idempotency records expire at 24h + grace. Pruning at 48h is
    // safe - no real client retries arrive that late.
    results.idempotencyRecords = await prune('idempotency_records',
      `created_at < NOW() - INTERVAL '48 hours'`);

    // Soft-deleted accounts. account/delete.js stamps users.deleted_at
    // and mangles the email so re-signup with the original address
    // works immediately; the actual row sticks around for 30 days so
    // a mistaken delete can be undone (super-admin clears deleted_at
    // + restores original email from the audit_events meta). After 30d
    // the DELETE here cascades workspaces → everything underneath.
    results.softDeletedUsers = await prune('users',
      `deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days'`);

    return ok(res, { ok: true, results, durationMs: Date.now() - t0 });
  } catch (err) {
    return serverError(res, err);
  }
}

// Delete rows matching `whereClause`, capped at BATCH_LIMIT. The
// DELETE ... USING (SELECT id FROM t WHERE ... LIMIT N) pattern
// would be more selective but requires every table to have an `id`
// PK - webhook_event_dedup uses a composite PK. Plain LIMIT in the
// DELETE itself is non-standard in Postgres; the safe portable
// pattern is to delete by primary key matches selected via CTE.
async function prune(tableName, whereClause) {
  try {
    // CTE picks the doomed rows by full PK (works for composite PKs
    // since we use SELECT *), DELETE joins on it. Each table's PK is
    // narrow enough that this stays fast.
    const text = `
      WITH doomed AS (
        SELECT ctid FROM ${tableName}
         WHERE ${whereClause}
         LIMIT ${BATCH_LIMIT}
      )
      DELETE FROM ${tableName} WHERE ctid IN (SELECT ctid FROM doomed)
    `;
    const r = await sql.query(text);
    return { deleted: r.rowCount ?? 0, table: tableName };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[db-prune] ${tableName}: ${err.message}`);
    try { reportError(err, { extra: { table: tableName, whereClause } }); }
    catch { /* ignore */ }
    return { error: err.message, table: tableName };
  }
}

export default trackCron('db-prune', handler);
