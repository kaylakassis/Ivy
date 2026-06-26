// /api/cron/owner-weekly-recap - weekly digest to business owners.
//
// Every Monday at 08:00 UTC, sweeps every active workspace and emails the
// owner a snapshot of the past 7 days: bookings completed, revenue
// collected, new clients, overdue invoices, and what's on the calendar
// for the week ahead. Honors the owner's 'reports' email preference
// (opt-out via Account → Notifications).
//
// Eligibility:
//   • workspace must be ACTIVE (trialing or paid). Lapsed/incomplete
//     owners get win-back, not recaps.
//   • onboarded_at IS NOT NULL — pre-onboarding owners have nothing to
//     summarize and shouldn't be nagged.
//   • user_type is not 'beta'/'sponsored' (they're not customers).
//   • weekly_recap_last_sent_at is NULL or > 6 days ago (idempotency
//     gate against a manually-triggered re-run inside the same week).
//
// Reuses notifyWeeklyRecap from api/_lib/weeklyRecap.js so the cron AND
// the admin preview render byte-identical email.
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { reportError } from '../_lib/monitoring.js';
import { notifyWeeklyRecap } from '../_lib/weeklyRecap.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { shardFromReq, shardClause, withDeadline, terminationReason } from '../_lib/cronShard.js';

// Per-batch fetch size. Each batch is one round-trip to Postgres + N
// sequential email sends (gated by Resend's 8/sec throttle). 250 is the
// sweet spot: small enough that we re-check the deadline often, large
// enough that the query overhead amortizes across many sends. The
// outer loop in withDeadline keeps pulling batches until the candidate
// set drains or the function nears its 5min Vercel cap.
const BATCH_SIZE = 250;
const REPEAT_AFTER_HOURS = 6 * 24; // 6 days

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    await ensureSchemaApplied();
    // Idempotent self-heal in case the schema column hasn't propagated yet.
    try {
      await sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS weekly_recap_last_sent_at TIMESTAMPTZ`;
    } catch {}

    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'w.id');

    // Past 7 days: [now - 7d, now). Calendar week alignment isn't
    // required — what we want is "the last week's worth of activity at
    // the moment this cron runs."
    const to = new Date();
    const from = new Date(Date.now() - 7 * 86400000);

    let scanned = 0, sent = 0, muted = 0, batches = 0;
    let emptied = false;

    // Deadline-driven loop: keep pulling batches until the candidate
    // set drains or we approach the function timeout. The stamp-then-
    // send pattern means a row stamped in batch N never re-appears in
    // batch N+1's candidate query, so the loop naturally terminates
    // even on a million-row backlog (limited only by wall-clock budget).
    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await sql.query(
          `SELECT w.id, w.owner_id
             FROM workspaces w
             JOIN users u ON u.id = w.owner_id
            WHERE w.onboarded_at IS NOT NULL
              AND COALESCE(u.user_type, 'regular') NOT IN ('beta', 'sponsored')
              AND u.deleted_at IS NULL
              AND (
                (w.subscription_status = 'trialing' AND w.trial_ends_at > NOW())
                OR (w.subscription_status = 'active' AND (w.subscription_period_end IS NULL OR w.subscription_period_end > NOW()))
                OR (w.subscription_status = 'past_due')
              )
              AND (
                w.weekly_recap_last_sent_at IS NULL
                OR w.weekly_recap_last_sent_at <= NOW() - ($1 || ' hours')::interval
              )
              ${shardFilter}
            ORDER BY w.created_at ASC
            LIMIT ${BATCH_SIZE}`,
          [String(REPEAT_AFTER_HOURS)],
        );
        if (rows.length === 0) { emptied = true; break; }
        scanned += rows.length;
        batches += 1;
        for (const r of rows) {
          try {
            // Stamp-then-send: stamp first so a retried cron run can't
            // double-send. The send itself is best-effort (the stamp
            // sticks regardless), which is the right tradeoff for a
            // weekly digest.
            // eslint-disable-next-line no-await-in-loop
            await sql`UPDATE workspaces SET weekly_recap_last_sent_at = NOW() WHERE id = ${r.id}`;
            // eslint-disable-next-line no-await-in-loop
            const result = await notifyWeeklyRecap({ workspaceId: r.id, from, to });
            if (result?.sent) sent++;
            else if (result?.reason === 'muted') muted++;
          } catch (err) {
            console.warn('[owner-weekly-recap] failed for workspace', r.id, err.message);
            reportError(err, { extra: { workspaceId: r.id } });
          }
          if (Date.now() >= deadline) break;
        }
      }
    });

    const terminatedBy = terminationReason({ emptied, hitCap: false });
    return ok(res, { ok: true, shard, shards, batches, scanned, sent, muted, terminatedBy });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

export default trackCron('owner-weekly-recap', handler);
