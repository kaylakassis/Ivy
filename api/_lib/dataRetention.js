// 7-day data retention after a paid subscription ends.
//
// Policy (owner-facing copy lives in subscriptionNotify.js):
//   • The day a workspace that has ever paid stops being active (cancelled
//     and the paid period ran out, suspended after dunning, or Apple
//     expiration) we stamp data_deletion_at = now + 7 days and tell the
//     owner by email + push: access has ended, download your data, it is
//     permanently deleted on <date> unless you resubscribe.
//   • ~2 days before the date we send one reminder.
//   • On the date, if the workspace is STILL inactive, every business row
//     tied to the workspace is deleted (clients, bookings, invoices,
//     documents, messages, website, automations, Ivy history, ...) and the
//     workspace row is reset to a blank shell. The owner's login and the
//     billing history (Stripe/Apple ids, converted_at, trial dates) are
//     kept so they can sign in, start again or delete the account, and so
//     a lapsed owner can never claim a second free trial.
//   • Resubscribing (or a comp from Admin) at any point before the date
//     cancels the deletion: the stamps are cleared and nothing happens.
//
// Trials that never paid get a longer clock: 4 weeks after the trial
// ended (never less than 7 days from when the clock is first set, so a
// backlog of old trials still gets a real notice). The win-back offer
// cron keeps running inside that window; the notice email and the 2-day
// reminder both point at picking a plan.
import { sql } from './db.js';
import { isWorkspaceActive, invalidateOwnerWorkspace } from './clientPortal.js';
import { evictWorkspaceGateCache } from './workspaceGate.js';
import { recordAudit } from './audit.js';
import { notifyDataDeletionScheduled, notifyDataDeletionReminder, notifyDataDeleted } from './subscriptionNotify.js';

export const RETENTION_DAYS = 7;
export const TRIAL_RETENTION_DAYS = 28;
export const MIN_NOTICE_DAYS = 7;
export const REMINDER_DAYS_BEFORE = 2;

// SQL mirror of isWorkspaceActive(). Keep the two in step.
const INACTIVE_SQL = `
  NOT (w.comp_until IS NOT NULL AND w.comp_until > NOW())
  AND NOT (w.subscription_status = 'trialing' AND w.trial_ends_at IS NOT NULL AND w.trial_ends_at > NOW())
  AND NOT (w.subscription_status = 'active' AND w.subscription_period_end IS NOT NULL AND w.subscription_period_end > NOW())
  AND COALESCE(w.subscription_status, 'inactive') <> 'past_due'`;

// Tables keyed by workspace_id that survive a purge: operator records
// with no business content (billing/reward ledgers, moderation reports,
// audit trail, usage counters, webhook dedup, bug reports to the operator).
export const RETAINED_TABLES = new Set([
  'audit_events', 'abuse_reports', 'ivy_usage', 'referral_reward_ledger',
  'apple_renewal_extensions', 'webhook_event_dedup', 'bug_reports',
]);

// Workspace columns that survive the reset: identity, billing state and
// the retention stamps themselves. Everything else goes back to default.
const KEEP_COLUMN = /^(id|owner_id|created_at|updated_at|subscription_.*|trial_.*|converted_at|stripe_.*|apple_.*|revenuecat_user_id|paywall_first_seen_at|winback_.*|comp_.*|cancel_at_period_end|plan_ending_reminder_sent_at|data_deletion_.*|data_purged_at|waitlist_discount_at)$/;

// 1. A paid workspace that is now inactive and not yet scheduled.
export async function scheduleDeletions() {
  const { rows } = await sql.query(`
    UPDATE workspaces w
       SET data_deletion_at = NOW() + ($1::int || ' days')::interval,
           data_deletion_notice_sent_at = NULL,
           data_deletion_reminder_sent_at = NULL
      FROM users u
     WHERE u.id = w.owner_id AND u.deleted_at IS NULL
       AND w.converted_at IS NOT NULL
       AND w.data_deletion_at IS NULL
       AND w.data_purged_at IS NULL
       AND ${INACTIVE_SQL}
    RETURNING w.id, w.data_deletion_at, w.subscription_period_end, w.subscription_source`,
    [RETENTION_DAYS]);
  // 1b. A trial that ended without ever paying: 4 weeks after the trial end.
  const trials = await sql.query(`
    UPDATE workspaces w
       SET data_deletion_at = GREATEST(w.trial_ends_at + ($1::int || ' days')::interval,
                                       NOW() + ($2::int || ' days')::interval),
           data_deletion_notice_sent_at = NULL,
           data_deletion_reminder_sent_at = NULL
      FROM users u
     WHERE u.id = w.owner_id AND u.deleted_at IS NULL
       AND w.converted_at IS NULL
       AND w.subscription_status = 'trialing'
       AND w.trial_ends_at IS NOT NULL AND w.trial_ends_at < NOW()
       AND w.data_deletion_at IS NULL
       AND w.data_purged_at IS NULL
       AND ${INACTIVE_SQL}
    RETURNING w.id, w.data_deletion_at, w.trial_ends_at`,
    [TRIAL_RETENTION_DAYS, MIN_NOTICE_DAYS]);
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await sql`UPDATE workspaces SET data_deletion_notice_sent_at = NOW() WHERE id = ${r.id}`;
    // eslint-disable-next-line no-await-in-loop
    await notifyDataDeletionScheduled({ workspaceId: r.id, deleteAt: r.data_deletion_at, endedAt: r.subscription_period_end, source: r.subscription_source });
  }
  for (const r of trials.rows) {
    // eslint-disable-next-line no-await-in-loop
    await sql`UPDATE workspaces SET data_deletion_notice_sent_at = NOW() WHERE id = ${r.id}`;
    // eslint-disable-next-line no-await-in-loop
    await notifyDataDeletionScheduled({ workspaceId: r.id, deleteAt: r.data_deletion_at, endedAt: r.trial_ends_at, trial: true });
  }
  return rows.length + trials.rows.length;
}

// 2. Resubscribed (or comped) before the date: call it off.
export async function clearRescued() {
  const { rows } = await sql.query(`
    UPDATE workspaces w
       SET data_deletion_at = NULL, data_deletion_notice_sent_at = NULL, data_deletion_reminder_sent_at = NULL
     WHERE w.data_deletion_at IS NOT NULL AND NOT (${INACTIVE_SQL})
    RETURNING w.id`);
  return rows.length;
}

// 3. One reminder ~2 days out.
export async function sendReminders() {
  const { rows } = await sql.query(`
    UPDATE workspaces w
       SET data_deletion_reminder_sent_at = NOW()
     WHERE w.data_deletion_at IS NOT NULL
       AND w.data_deletion_reminder_sent_at IS NULL
       AND w.data_deletion_at <= NOW() + ($1::int || ' days')::interval
       AND w.data_deletion_at > NOW()
       AND ${INACTIVE_SQL}
    RETURNING w.id, w.data_deletion_at, (w.converted_at IS NULL) AS trial`, [REMINDER_DAYS_BEFORE]);
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await notifyDataDeletionReminder({ workspaceId: r.id, deleteAt: r.data_deletion_at, trial: r.trial });
  }
  return rows.length;
}

// Delete every business row for one workspace and reset the shell.
// Idempotent: safe to re-run if an earlier attempt died halfway.
export async function purgeWorkspaceData(workspaceId) {
  const { rows: cols } = await sql.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'workspace_id' AND table_name <> 'workspaces'
      ORDER BY table_name`);
  const deleted = {};
  for (const { table_name: t } of cols) {
    if (RETAINED_TABLES.has(t)) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await sql.query(`DELETE FROM "${t}" WHERE workspace_id = $1`, [workspaceId]);
    if (r.rowCount) deleted[t] = r.rowCount;
  }
  const { rows: wcols } = await sql.query(
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'workspaces'`);
  const resets = wcols
    .filter((c) => !KEEP_COLUMN.test(c.column_name))
    .filter((c) => c.is_nullable === 'YES' || c.column_default != null)
    .map((c) => `"${c.column_name}" = DEFAULT`);
  await sql.query(
    `UPDATE workspaces SET ${resets.join(', ')}, data_purged_at = NOW(), data_deletion_at = NULL WHERE id = $1`,
    [workspaceId]);
  return deleted;
}

// 4. Due and still inactive → purge. Re-checks the live row with the same
//    predicate the paywall uses, right before deleting.
export async function purgeDue() {
  const { rows } = await sql.query(`
    SELECT w.id, w.owner_id, w.data_deletion_at, w.subscription_status, w.trial_ends_at,
           w.subscription_period_end, w.comp_until, u.email, u.name
      FROM workspaces w JOIN users u ON u.id = w.owner_id
     WHERE w.data_deletion_at IS NOT NULL AND w.data_deletion_at <= NOW() AND w.data_purged_at IS NULL
     ORDER BY w.data_deletion_at ASC LIMIT 200`);
  let purged = 0;
  for (const w of rows) {
    if (isWorkspaceActive(w)) {
      // eslint-disable-next-line no-await-in-loop
      await sql`UPDATE workspaces SET data_deletion_at = NULL, data_deletion_notice_sent_at = NULL, data_deletion_reminder_sent_at = NULL WHERE id = ${w.id}`;
      continue;
    }
    // Snapshot for the confirmation email before the sweep (notifications
    // and ivy sessions go with the workspace).
    // eslint-disable-next-line no-await-in-loop
    const deleted = await purgeWorkspaceData(w.id);
    purged++;
    evictWorkspaceGateCache(w.id);
    invalidateOwnerWorkspace(w.owner_id);
    // eslint-disable-next-line no-await-in-loop
    await recordAudit(null, {
      actor: null, targetUserId: w.owner_id, action: 'workspace.retention_purge',
      meta: { workspaceId: w.id, scheduledFor: w.data_deletion_at, tables: deleted },
    });
    // eslint-disable-next-line no-await-in-loop
    await notifyDataDeleted({ email: w.email, name: w.name });
  }
  return purged;
}

export async function runDataRetention() {
  const rescued = await clearRescued();
  const scheduled = await scheduleDeletions();
  const reminded = await sendReminders();
  const purged = await purgeDue();
  return { rescued, scheduled, reminded, purged };
}
