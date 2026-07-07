// Daily trial-ending reminder drip.
//
// What this does:
//   • Sweeps workspaces still on a LIVE trial (subscription_status =
//     'trialing') and emails a stage-appropriate nudge as trial_ends_at
//     approaches: ~7 days out, ~2 days out (the heads-up the paywall
//     promises), ~1 day out, and at expiry.
//   • Each stage stamps its own column (trial_reminder_7d_sent_at, …) so
//     a workspace gets each nudge AT MOST ONCE. The stamp is written
//     before the (async) send so a retry or overlapping run can't double
//     up - same stamp-then-send idempotency the win-back path uses.
//
// Relationship to win-back: these fire DURING the trial; the win-back
// cron fires only AFTER a workspace has lapsed (3 days past
// paywall_first_seen_at, never converted). The two never overlap, so the
// owner sees: 7-day nudge → 2-day heads-up → 1-day nudge → expiry notice →
// (if still no sub) win-back offer. No double-sends.
//
// Rollout safety: the 'expired' stage is bounded to trials that ended
// within the last 3 days, so turning this on does NOT blast every
// long-lapsed trialing workspace with a "your trial ended" email - those
// are already the win-back cron's job.
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { notifyTrialReminder } from '../_lib/subscriptionNotify.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

// Per-run, per-stage ceiling so a large backfill can't burst a flood of
// emails in one run; the rest roll to the next day's run.
// Per STAGE (7d/1d/expired), so the effective daily ceiling is 3×.
// Sized for ~100K active trialing workspaces.
const MAX_PER_RUN = 1000;

// Disjoint windows keyed off trial_ends_at. Literals are trusted (no user
// input) so they're inlined directly into the SQL. The bounds are kept fully
// disjoint (7d: >2d..7d, 2d: >1d..2d, 1d: >now..1d) so a trial can't match two
// stages on the same run and get two emails at once.
const STAGES = [
  {
    stage: '7d',
    stampCol: 'trial_reminder_7d_sent_at',
    window: `w.trial_ends_at > NOW() + INTERVAL '2 days'
             AND w.trial_ends_at <= NOW() + INTERVAL '7 days'`,
  },
  {
    // The heads-up the paywall promises: ~2 days before the trial ends.
    stage: '2d',
    stampCol: 'trial_reminder_2d_sent_at',
    window: `w.trial_ends_at > NOW() + INTERVAL '1 day'
             AND w.trial_ends_at <= NOW() + INTERVAL '2 days'`,
  },
  {
    stage: '1d',
    stampCol: 'trial_reminder_1d_sent_at',
    window: `w.trial_ends_at > NOW()
             AND w.trial_ends_at <= NOW() + INTERVAL '1 day'`,
  },
  {
    stage: 'expired',
    stampCol: 'trial_expired_notice_sent_at',
    // Lower-bounded so rollout doesn't notify ancient lapsed trials.
    window: `w.trial_ends_at <= NOW()
             AND w.trial_ends_at > NOW() - INTERVAL '3 days'`,
  },
];

async function processStage({ stage, stampCol, window }) {
  const { rows } = await sql.query(
    `SELECT w.id AS workspace_id, w.trial_ends_at
       FROM workspaces w
       JOIN users u ON u.id = w.owner_id
      WHERE w.subscription_status = 'trialing'
        AND ${window}
        AND w.${stampCol} IS NULL
        AND u.email IS NOT NULL
        AND COALESCE(u.user_type, 'regular') <> 'sponsored'
      ORDER BY w.trial_ends_at ASC
      LIMIT $1`,
    [MAX_PER_RUN],
  );

  let sent = 0;
  for (const r of rows) {
    // Stamp first under the IS NULL guard; a lost race (another run /
    // retry) returns zero rows and we skip without re-sending.
    // eslint-disable-next-line no-await-in-loop
    const upd = await sql.query(
      `UPDATE workspaces SET ${stampCol} = NOW()
        WHERE id = $1 AND ${stampCol} IS NULL
        RETURNING id`,
      [r.workspace_id],
    );
    if (upd.rows.length === 0) continue;
    sent++;
    notifyTrialReminder({ workspaceId: r.workspace_id, stage, trialEndsAt: r.trial_ends_at })
      .catch((e) => console.error(`[trial-reminders] ${stage} email failed:`, r.workspace_id, e?.message));
  }
  return { scanned: rows.length, sent };
}

async function handler(req, res) {
  // Same three-path auth as the other crons: Vercel cron header, an
  // admin secret for manual kicks, or a super-admin session for an
  // in-app trigger.
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    let scanned = 0;
    const byStage = {};
    for (const cfg of STAGES) {
      // eslint-disable-next-line no-await-in-loop
      const r = await processStage(cfg);
      scanned += r.scanned;
      byStage[cfg.stage] = r.sent;
    }
    const sent = Object.values(byStage).reduce((a, b) => a + b, 0);
    // Metrics get captured by the trackCron wrapper from this response
    // body. extractMetrics keeps top-level scalars and drops nested
    // objects, so we spread byStage's per-stage counts into the top level
    // instead of nesting them under a `byStage` key.
    return ok(res, { scanned, sent, ...byStage });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('trial-reminders', handler);
