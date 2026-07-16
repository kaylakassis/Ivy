// POST /api/billing/sync   body: { sessionId? }
// Race-mitigation for the gap between Stripe Checkout success redirect and
// the webhook arriving. The frontend hits this on success-page mount; we
// fetch the session (or the workspace's known subscription) directly from
// Stripe and update the workspaces row so the Paywall dismisses
// immediately, even if the webhook hasn't landed yet.
//
// Idempotent: writes the same fields the webhook would, with WHERE clauses
// that only mutate when the new state is actually newer.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchCheckoutSession, fetchSubscription, platformStripeSecret } from '../_lib/stripe.js';
import { mapStripeStatus } from '../_lib/billing.js';
import { attributePayment, monthlyValueCents } from '../_lib/affiliateAttribution.js';
import { evictWorkspaceGateCache } from '../_lib/workspaceGate.js';
import { invalidateOwnerWorkspace } from '../_lib/clientPortal.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const PAYING_STATUSES = new Set(['active', 'past_due']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const secretKey = platformStripeSecret();
    if (!secretKey) return badRequest(res, 'Subscription billing is not configured.');

    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    const sessionId = body.sessionId ? String(body.sessionId) : null;

    let customerId = null;
    let subscription = null;

    if (sessionId) {
      const session = await fetchCheckoutSession({ secretKey, sessionId });
      // Defensive: the session must belong to this workspace. Stripe lets
      // anyone with a session id query it via their secret key, but we
      // refuse to apply changes meant for someone else's workspace.
      if (session.metadata?.workspace_id !== workspaceId) {
        return badRequest(res, 'Session does not belong to this workspace.');
      }
      customerId = session.customer || null;
      subscription = typeof session.subscription === 'object'
        ? session.subscription
        : (session.subscription ? await fetchSubscription({ secretKey, subscriptionId: session.subscription }) : null);
    } else {
      // No session id supplied - fall back to the workspace's stored
      // subscription id and re-fetch it.
      const { rows } = await sql`
        SELECT stripe_customer_id, stripe_subscription_id FROM workspaces WHERE id = ${workspaceId}
      `;
      customerId = rows[0]?.stripe_customer_id || null;
      const subId = rows[0]?.stripe_subscription_id;
      if (subId) subscription = await fetchSubscription({ secretKey, subscriptionId: subId });
    }

    if (!subscription) {
      return ok(res, { synced: false, reason: 'no subscription found' });
    }

    const mapped = mapStripeStatus(subscription.status);
    const periodEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null;
    // Card-backed trial: mirror Stripe's trial_end into trial_ends_at,
    // exactly like the billing webhook does. Without this, sync set
    // status='trialing' while trial_ends_at stayed NULL - and
    // isWorkspaceActive's trialing branch (trial_ends_at > now) still
    // failed, so a user who JUST subscribed kept seeing the paywall.
    const isTrialing = mapped === 'trialing';
    const trialEnd = subscription.trial_end
      ? new Date(subscription.trial_end * 1000)
      : periodEnd;

    await sql`
      UPDATE workspaces SET
        subscription_status     = ${mapped},
        stripe_customer_id      = ${customerId},
        stripe_subscription_id  = ${subscription.id},
        subscription_period_end = ${periodEnd},
        trial_ends_at            = CASE WHEN ${isTrialing} THEN ${trialEnd} ELSE trial_ends_at END,
        -- Funnel: stamp the first conversion. COALESCE keeps the
        -- original timestamp on every subsequent sync so we measure
        -- FIRST-paying-time, not most-recent-renewal.
        converted_at            = CASE
          WHEN ${mapped} IN ('active', 'past_due')
          THEN COALESCE(converted_at, NOW())
          ELSE converted_at
        END
      WHERE id = ${workspaceId}
    `;
    if (PAYING_STATUSES.has(mapped)) {
      await attributePayment({
        workspaceId,
        valueCents: monthlyValueCents(subscription),
      }).catch((e) => console.warn('[billing/sync] attribute failed:', e.message));
    }
    // Drop the per-lambda positive cache so the very next gated
    // request sees the fresh paying state, not a pre-checkout snapshot.
    // No-op when the cache is empty. Also drop the ownsWorkspace
    // hot-cache for the same reason: the immediate /api/me refresh
    // after Stripe redirect must see the workspace as paying or the
    // paywall will flash back on for a TTL window after a successful
    // checkout.
    evictWorkspaceGateCache(workspaceId);
    invalidateOwnerWorkspace(user.id);
    return ok(res, {
      synced: true,
      status: mapped,
      periodEnd: periodEnd ? periodEnd.toISOString() : null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
