// GET /api/admin/cron-health - observability dashboard for cron jobs.
// Returns per-cron summary stats over the last 24h and 7d plus the
// last 20 runs of each, so operators can spot regressions:
//   - sudden drop in success rate
//   - latency creeping up
//   - "items processed" trending down (signals upstream breakage)
//
// Backed by the cron_runs table (every cron is wrapped with
// trackCron() - see api/_lib/cronMetrics.js).
//
// Super-admin only.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin } from '../_lib/admin.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    // Summary: per-cron rollup over the last 24h and 7d, separately.
    // FILTER lets us compute both windows in one pass.
    const { rows: summaries } = await sql`
      SELECT
        name,
        COUNT(*) FILTER (WHERE finished_at >= NOW() - INTERVAL '24 hours')                        AS runs_24h,
        COUNT(*) FILTER (WHERE finished_at >= NOW() - INTERVAL '24 hours' AND ok = TRUE)          AS ok_24h,
        COUNT(*) FILTER (WHERE finished_at >= NOW() - INTERVAL '24 hours' AND ok = FALSE)         AS failed_24h,
        COUNT(*) FILTER (WHERE finished_at >= NOW() - INTERVAL '7 days')                          AS runs_7d,
        COUNT(*) FILTER (WHERE finished_at >= NOW() - INTERVAL '7 days' AND ok = FALSE)           AS failed_7d,
        ROUND(AVG(duration_ms) FILTER (WHERE finished_at >= NOW() - INTERVAL '7 days'))::int      AS avg_duration_ms_7d,
        MAX(duration_ms) FILTER (WHERE finished_at >= NOW() - INTERVAL '7 days')                  AS max_duration_ms_7d,
        MAX(finished_at)                                                                          AS last_run_at
      FROM cron_runs
      WHERE finished_at >= NOW() - INTERVAL '7 days'
      GROUP BY name
      ORDER BY name
    `;

    // Recent run details - last 20 per cron.
    const { rows: recent } = await sql`
      SELECT name, started_at, finished_at, duration_ms, ok, metrics, error_message
      FROM (
        SELECT name, started_at, finished_at, duration_ms, ok, metrics, error_message,
               ROW_NUMBER() OVER (PARTITION BY name ORDER BY finished_at DESC NULLS LAST) AS rn
        FROM cron_runs
        WHERE finished_at >= NOW() - INTERVAL '7 days'
      ) x
      WHERE rn <= 20
      ORDER BY name, finished_at DESC
    `;

    // Group recent runs by cron name for the UI.
    const byName = {};
    for (const r of recent) {
      if (!byName[r.name]) byName[r.name] = [];
      byName[r.name].push({
        startedAt:   r.started_at,
        finishedAt:  r.finished_at,
        durationMs:  r.duration_ms,
        ok:          r.ok,
        metrics:     r.metrics || {},
        errorMessage: r.error_message,
      });
    }

    return ok(res, {
      summaries: summaries.map((s) => ({
        name:          s.name,
        runs24h:       Number(s.runs_24h),
        ok24h:         Number(s.ok_24h),
        failed24h:     Number(s.failed_24h),
        runs7d:        Number(s.runs_7d),
        failed7d:      Number(s.failed_7d),
        avgDurationMs: s.avg_duration_ms_7d,
        maxDurationMs: s.max_duration_ms_7d,
        lastRunAt:     s.last_run_at,
      })),
      recent: byName,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
