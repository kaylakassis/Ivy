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

// Sized for ~100K active workspaces. The 6-day cooldown distributes
// owners across the week naturally; this is the maximum we'll send in
// any single cron invocation.
const MAX_PER_RUN = 2000;
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

    // Sweep candidates. The eligibility window matches the comment
    // above; isWorkspaceActive's semantics are inlined as SQL so the
    // query stays cheap (one indexed scan rather than per-row JS).
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
        ORDER BY w.created_at ASC
        LIMIT ${MAX_PER_RUN}`,
      [String(REPEAT_AFTER_HOURS)],
    );

    // Past 7 days: [now - 7d, now). Calendar week alignment isn't
    // required — what we want is "the last week's worth of activity at
    // the moment this cron runs."
    const to = new Date();
    const from = new Date(Date.now() - 7 * 86400000);

    let sent = 0;
    let muted = 0;
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
    }

    return ok(res, { ok: true, scanned: rows.length, sent, muted });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

export default trackCron('owner-weekly-recap', handler);
