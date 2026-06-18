// Daily subscription dunning sweep.
//
// What this does:
//   • Finds workspaces that have been past_due for >= GRACE_DAYS.
//     Flips them to 'suspended' so the UI gating layer can block
//     write actions (handler-level guards + read-only mode banner).
//   • Sends a dunning email each day during the grace window
//     (capped at one per workspace per day via the
//     subscription_last_dunning_at column).
//   • Sends a final "your account is now suspended" notification at
//     suspension time.
//
// Stripe's own smart-retry handles the actual card retries; this
// cron is the GROUND-TRUTH for "how long has this been past_due"
// and the policy for what happens when retries don't recover.
//
// Why a cron + not just the webhook: the webhook fires on attempt
// failure. We want a separate "it's been N days, ENFORCE policy"
// signal that doesn't depend on Stripe's retry cadence.
//
// Tunables:
//   GRACE_DAYS - how many days past_due before suspension. 14 days
//                matches Stripe's default smart-retry window so by
//                the time we suspend, every retry has been tried.
//   DUNNING_EMAIL_EVERY_HOURS - re-email cadence during grace.
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { notifyPaymentFailed } from '../_lib/subscriptionNotify.js';
import { notifyOwnerSafe } from '../_lib/push.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

const GRACE_DAYS = 14;
const DUNNING_EMAIL_EVERY_HOURS = 24;

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    let suspended = 0;
    let dunned = 0;
    let scanned = 0;

    // 1. Suspend anyone past_due >= GRACE_DAYS and not yet
    //    suspended. Conditional UPDATE so the cron is idempotent -
    //    a re-run only touches rows that meet the threshold and
    //    haven't already been suspended.
    const suspendResult = await sql`
      UPDATE workspaces SET
        subscription_status       = 'suspended',
        subscription_suspended_at = NOW()
      WHERE subscription_status = 'past_due'
        AND subscription_past_due_since IS NOT NULL
        AND subscription_past_due_since <= NOW() - (${GRACE_DAYS} || ' days')::interval
        AND subscription_suspended_at IS NULL
      RETURNING id
    `;
    suspended = suspendResult.rowCount ?? 0;
    // Push the owner of every just-suspended workspace - this is the
    // moment write-actions start failing, so silence here is dangerous.
    for (const w of suspendResult.rows || []) {
      notifyOwnerSafe({
        workspaceId: w.id, type: 'payments',
        payload: {
          title: 'Subscription suspended',
          body: 'Card retries exhausted - update payment to restore access.',
          url: '/account?tab=billing',
          tag: `subscription-suspended-${w.id}`,
        },
      });
    }

    // 2. Dunning emails for workspaces still inside the grace
    //    window, capped at one per day per workspace.
    const dueForDunning = await sql`
      SELECT id, subscription_past_due_since, subscription_failed_attempts
      FROM workspaces
      WHERE subscription_status = 'past_due'
        AND subscription_past_due_since IS NOT NULL
        AND subscription_suspended_at IS NULL
        AND (
          subscription_last_dunning_at IS NULL
          OR subscription_last_dunning_at <= NOW() - (${DUNNING_EMAIL_EVERY_HOURS} || ' hours')::interval
        )
      LIMIT 500
    `;

    for (const w of dueForDunning.rows) {
      scanned++;
      try {
        // We don't have the original amount/currency on the workspace
        // row - that lives on the Stripe invoice. The notify helper
        // already handles a minimal call (no nextAttemptAt is fine,
        // it just omits that line). Owner gets a reminder; if they
        // want detail they click into Billing.
        await notifyPaymentFailed({ workspaceId: w.id });
        notifyOwnerSafe({
          workspaceId: w.id, type: 'payments',
          payload: {
            title: 'Subscription payment overdue',
            body: "Stripe couldn't charge your card. Update it to keep your account active.",
            url: '/account?tab=billing',
            tag: `subscription-dunning-${w.id}`,
          },
        });
        await sql`
          UPDATE workspaces SET subscription_last_dunning_at = NOW()
          WHERE id = ${w.id}
        `;
        dunned++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[subscription-dunning] failed for workspace', w.id, err.message);
      }
    }

    return ok(res, { suspended, dunned, scanned });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('subscription-dunning', handler);
