// /api/cron/daily-return - the daily-return push loop. Originally two
// timezone-aware "beats"; since 1.0.6 only the evening one runs (the
// morning briefing is now part of the accountability partner):
//
//   • Morning (~8am local): RETIRED in 1.0.6. The briefing push now lives in
//     the accountability partner's daily message.
//
//   • Evening (~7pm local): a "streak at risk" push to owners who have a
//     streak worth saving (>= 2 days) but haven't advanced it today. Opening
//     the dashboard (the push target) calls touchStreak and keeps it alive.
//     Skipped on a day the accountability partner already wrote, so Ivy
//     sends at most one nudge a day.
//
// Runs HOURLY. Since Vercel crons fire at fixed UTC times but "8am" must mean
// the OWNER's 8am, each beat selects only workspaces whose LOCAL hour (via the
// workspace timezone) equals the beat hour. Dedupe is one column per beat on
// workspaces, compared against a >20h interval so a DST fall-back hour-repeat
// or a retried run can't double-send. Mirrors the owner-weekly-recap harness
// (auth triple, ensureSchemaApplied, sharding, withDeadline, trackCron).
import { sql } from '../_lib/db.js';
import { cronAuthorized } from '../_lib/cronAuth.js';
import { reportError } from '../_lib/monitoring.js';
import { notifyOwnerSafe } from '../_lib/push.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { shardFromReq, shardClause, withDeadline, terminationReason } from '../_lib/cronShard.js';

const EVENING_HOUR = 19;      // owner-local hour for the streak-at-risk beat
const BATCH_SIZE = 250;
const REPEAT_AFTER_HOURS = 20; // dedupe guard - DST-safe (not a same-day compare)
const HALF_BUDGET_MS = 135_000; // split the 4m30s cron budget across the two beats

// Eligibility shared by both beats (inlined in each query so the shard filter
// can be appended): an onboarded, still-paying (or trialing/past-due) owner who
// can actually receive a push. Copied from owner-weekly-recap's "not dormant/
// cancelled" filter. cs.timezone is guarded via a join to pg_timezone_names so
// an Intl-valid-but-PG-unknown name can't throw the query (we COALESCE to UTC);
// NEVER inline cs.timezone into AT TIME ZONE directly.
async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);

  try {
    await ensureSchemaApplied();
    // Idempotent self-heal in case the dedupe columns haven't propagated yet.
    try {
      await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS briefing_push_last_sent_at TIMESTAMPTZ`;
      await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS streak_push_last_sent_at TIMESTAMPTZ`;
    } catch { /* best-effort */ }

    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'w.id');

    let eveningScanned = 0, eveningSent = 0, eveningEmptied = false;

    // The morning briefing beat (~8am push of buildBriefing's top item) was
    // retired in 1.0.6: the accountability partner (api/cron/accountability-
    // partner.js) now sends the one daily "here's what needs you" message,
    // with the same items and more, so owners never get both. Its response
    // counters stay (always 0) for the cron-health dashboard.
    const morningScanned = 0, morningSent = 0, morningEmptied = true;

    // ─── Beat 2: evening streak-at-risk ─────────────────────────────────
    // streak_last_day = yesterday-in-their-tz means "active yesterday, not yet
    // today" - the ONLY genuinely-savable case. (An owner who wandered off a
    // week ago still carries a stale streak_days until their next dashboard
    // load resets it; = today-1 excludes them, so we never nudge a dead streak.)
    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await sql.query(
          `SELECT w.id, w.owner_id, w.streak_days
             FROM workspaces w
             JOIN users u ON u.id = w.owner_id
             LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
             LEFT JOIN pg_timezone_names  z ON z.name = cs.timezone
            WHERE w.onboarded_at IS NOT NULL
              AND u.deleted_at IS NULL
              AND COALESCE(u.user_type, 'regular') NOT IN ('beta', 'sponsored')
              AND (
                (w.subscription_status = 'trialing' AND w.trial_ends_at > NOW())
                OR (w.subscription_status = 'active' AND (w.subscription_period_end IS NULL OR w.subscription_period_end > NOW()))
                OR (w.subscription_status = 'past_due')
              )
              AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE COALESCE(z.name, 'UTC')))::int = $1
              AND w.streak_days >= 2
              AND w.streak_last_day = ((NOW() AT TIME ZONE COALESCE(z.name, 'UTC'))::date - 1)
              AND (w.streak_push_last_sent_at IS NULL
                   OR w.streak_push_last_sent_at < NOW() - ($2 || ' hours')::interval)
              -- One Ivy nudge a day: no streak push on a day the
              -- accountability partner already wrote.
              AND (w.partner_last_sent_day IS NULL
                   OR w.partner_last_sent_day < (NOW() AT TIME ZONE COALESCE(z.name, 'UTC'))::date)
              AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.user_id = w.owner_id)
              ${shardFilter}
            ORDER BY w.id
            LIMIT ${BATCH_SIZE}`,
          [EVENING_HOUR, String(REPEAT_AFTER_HOURS)],
        );
        if (rows.length === 0) { eveningEmptied = true; break; }
        eveningScanned += rows.length;
        for (const r of rows) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const claim = await sql`
              UPDATE workspaces SET streak_push_last_sent_at = NOW()
               WHERE id = ${r.id}
                 AND (streak_push_last_sent_at IS NULL
                      OR streak_push_last_sent_at < NOW() - (${String(REPEAT_AFTER_HOURS)} || ' hours')::interval)
              RETURNING id`;
            if (claim.rows.length === 0) continue;
            // eslint-disable-next-line no-await-in-loop
            await notifyOwnerSafe({
              workspaceId: r.id, type: 'engagement',
              payload: {
                title: 'Keep your streak alive',
                body: `🔥 Keep your ${r.streak_days}-day streak - a quick check-in keeps it going.`,
                url: '/dashboard',
                tag: 'streak-risk',
              },
            });
            eveningSent++;
          } catch (err) {
            console.warn('[daily-return/evening] failed for', r.id, err.message);
            reportError(err, { extra: { workspaceId: r.id, beat: 'evening' } });
          }
          if (Date.now() >= deadline) break;
        }
      }
    }, { budgetMs: HALF_BUDGET_MS });

    const terminatedBy = terminationReason({ emptied: morningEmptied && eveningEmptied, hitCap: false });
    return ok(res, {
      ok: true, shard, shards,
      morningScanned, morningSent, eveningScanned, eveningSent, terminatedBy,
    });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

export default trackCron('daily-return', handler);
