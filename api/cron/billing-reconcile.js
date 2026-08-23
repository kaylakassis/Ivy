// /api/cron/billing-reconcile - daily. Ground-truth sync of IVY'S OWN
// subscribers (workspaces.subscription_status) against Stripe.
//
// Why this exists: the billing webhook (/api/webhooks/billing) is the
// fast path for renewals / payment failures / cancellations - and it
// has now broken twice (missing endpoint secret → Stripe disabled it).
// Stripe only retains events ~30 days, so a long outage leaves
// permanent drift the webhook can never repair: a cancelled or
// non-paying subscriber keeps full access, silently. This cron re-reads
// each workspace's subscription from Stripe and re-applies the true
// state, so any webhook outage self-heals within a day.
//
// This is the platform-billing sibling of api/cron/stripe-reconcile.js
// (which reconciles owners' CLIENT memberships on their connected
// accounts, not Ivy's own subscribers).
//
// Semantics mirror the billing webhook exactly:
//   • mapStripeStatus for the status enum
//   • trial fields stamped while trialing; converted_at stamped once
//   • active clears the dunning bookkeeping (same as a payment_succeeded)
//   • Apple-billed workspaces are NEVER touched (RevenueCat owns them)
// Writes only when something actually changed (IS DISTINCT FROM guard),
// and busts the owner-workspace cache for changed rows only.
import { sql } from '../_lib/db.js';
import { fetchSubscription, platformStripeSecret } from '../_lib/stripe.js';
import { mapStripeStatus } from '../_lib/billing.js';
import { invalidateOwnerWorkspaceByWorkspaceId } from '../_lib/clientPortal.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { withDeadline, terminationReason } from '../_lib/cronShard.js';

const BATCH_SIZE = 50;
const BUDGET_MS = 250_000; // under the api/cron/** 300s function cap

// Exported for tests: reconcile ONE workspace row against a fetched
// Stripe subscription object. Returns 'applied' | 'unchanged'.
export async function applyWorkspaceSubState({ workspaceId, sub }) {
  const status = mapStripeStatus(sub.status);
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
  const isTrialing = status === 'trialing';
  const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : periodEnd;
  const isActive = status === 'active';

  const upd = await sql`
    UPDATE workspaces SET
      subscription_status     = ${status},
      subscription_period_end = ${periodEnd},
      trial_ends_at    = CASE WHEN ${isTrialing} THEN ${trialEnd} ELSE trial_ends_at END,
      trial_started_at = CASE WHEN ${isTrialing} THEN COALESCE(trial_started_at, NOW()) ELSE trial_started_at END,
      converted_at     = CASE WHEN ${isActive} THEN COALESCE(converted_at, NOW()) ELSE converted_at END,
      -- A truly-active sub leaves no dunning ghosts (mirrors the
      -- webhook's invoice.payment_succeeded path) so the dunning cron
      -- can't suspend a recovered subscriber off stale bookkeeping.
      subscription_past_due_since  = CASE WHEN ${isActive} THEN NULL ELSE subscription_past_due_since END,
      subscription_failed_attempts = CASE WHEN ${isActive} THEN 0 ELSE subscription_failed_attempts END,
      subscription_suspended_at    = CASE WHEN ${isActive} THEN NULL ELSE subscription_suspended_at END
    WHERE id = ${workspaceId}
      AND COALESCE(subscription_source, 'stripe') <> 'apple'
      AND (subscription_status IS DISTINCT FROM ${status}
        OR subscription_period_end IS DISTINCT FROM ${periodEnd})
    RETURNING id
  `;
  if (upd.rows.length === 0) return 'unchanged';
  await invalidateOwnerWorkspaceByWorkspaceId(workspaceId).catch(() => {});
  return 'applied';
}

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== expected) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await ensureSchemaApplied();
    const secretKey = platformStripeSecret();
    if (!secretKey) return ok(res, { skipped: 'platform Stripe not configured' });

    let scanned = 0, applied = 0, unchanged = 0, errors = 0;
    let emptied = false;
    let lastId = '00000000-0000-0000-0000-000000000000';

    await withDeadline(async (deadline) => {
      while (Date.now() < deadline) {
        // Keyset pagination over every non-Apple workspace that has a
        // Stripe subscription on file. Deleted owners' workspaces are
        // synced too - flipping a dead account's stale 'active' to
        // 'cancelled' is correct and harmless.
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await sql`
          SELECT id, stripe_subscription_id FROM workspaces
          WHERE stripe_subscription_id IS NOT NULL
            AND COALESCE(subscription_source, 'stripe') <> 'apple'
            AND id > ${lastId}::uuid
          ORDER BY id ASC
          LIMIT ${BATCH_SIZE}
        `;
        if (rows.length === 0) { emptied = true; break; }
        for (const w of rows) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const sub = await fetchSubscription({ secretKey, subscriptionId: w.stripe_subscription_id });
            // eslint-disable-next-line no-await-in-loop
            const outcome = await applyWorkspaceSubState({ workspaceId: w.id, sub });
            if (outcome === 'applied') applied++; else unchanged++;
          } catch (err) {
            // Unknown/foreign subscription id, transient Stripe error -
            // log and move on; one bad row must not stall the sweep.
            errors++;
            // eslint-disable-next-line no-console
            console.warn('[billing-reconcile]', w.id, err.message);
          }
          scanned++;
          if (Date.now() >= deadline) break;
        }
        lastId = rows[rows.length - 1].id;
        if (rows.length < BATCH_SIZE) { emptied = true; break; }
      }
    }, { budgetMs: BUDGET_MS });

    const terminatedBy = terminationReason({ emptied, hitCap: false });
    return ok(res, { scanned, applied, unchanged, errors, terminatedBy });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('billing-reconcile', handler);
