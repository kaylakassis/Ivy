// POST /api/memberships/change-plan
//   body: { clientMembershipId, newMembershipId }
//
// Owner-side endpoint to switch a client's recurring tier. Calls Stripe
// subscriptions.update with the new price + proration_behavior=
// create_prorations — Stripe applies the credit/charge for the
// remainder of the current period to the next invoice. The
// customer.subscription.updated webhook then carries the new items[]
// and applySubscriptionState resyncs the local snapshot
// (membership_id/name/price_cents/interval).
//
// The endpoint does NOT mutate client_memberships directly; that's
// the webhook's job. We just return the updated subscription summary.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { loadStripeCreds } from '../_lib/stripeCreds.js';
import { fetchSubscription, updateSubscriptionPrice } from '../_lib/stripe.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (!(await requireActiveSubscription(workspaceId, req, res))) return;

    const body = await readBody(req);
    const cmId = String(body.clientMembershipId || '').trim();
    const newMembershipId = String(body.newMembershipId || '').trim();
    if (!cmId)             return badRequest(res, 'clientMembershipId is required');
    if (!newMembershipId)  return badRequest(res, 'newMembershipId is required');

    // Look up the live membership row scoped to this workspace. The
    // FK + workspace_id guard means an owner can't change a plan for
    // a client in another workspace even if they guess the id.
    const cm = (await sql`
      SELECT id, stripe_subscription_id, membership_id, status
        FROM client_memberships
       WHERE id = ${cmId} AND workspace_id = ${workspaceId}
       LIMIT 1
    `).rows[0];
    if (!cm) return notFound(res, 'Membership not found');
    if (cm.status === 'cancelled') return badRequest(res, "This client's membership is cancelled");
    if (!cm.stripe_subscription_id) return badRequest(res, 'No Stripe subscription on file for this membership');
    if (cm.membership_id === newMembershipId) {
      return badRequest(res, 'Client is already on that tier');
    }

    // Resolve the new tier (workspace-scoped, must have a Stripe price).
    const tier = (await sql`
      SELECT id, name, stripe_price_id, active
        FROM memberships
       WHERE id = ${newMembershipId} AND workspace_id = ${workspaceId}
       LIMIT 1
    `).rows[0];
    if (!tier) return notFound(res, 'New tier not found');
    if (!tier.active) return badRequest(res, "That tier isn't accepting new members");
    if (!tier.stripe_price_id) return badRequest(res, 'New tier has no Stripe price provisioned');

    const creds = await loadStripeCreds(workspaceId);

    // Stripe needs the SubscriptionItem id to swap the price — fetch
    // the current sub to get items.data[0].id. Defense: re-confirm
    // the subscription's metadata.workspace_id matches when present,
    // so a stale stripe_subscription_id from a re-onboarded account
    // can't route a price-change at someone else's customer.
    let sub;
    try {
      sub = await fetchSubscription({
        secretKey: creds.secretKey,
        stripeAccount: creds.stripeAccount,
        subscriptionId: cm.stripe_subscription_id,
      });
    } catch (err) {
      return serverError(res, err);
    }
    const item = sub?.items?.data?.[0];
    if (!item?.id) return badRequest(res, 'Stripe subscription has no items to swap');
    if (sub.metadata?.workspace_id && sub.metadata.workspace_id !== workspaceId) {
      return badRequest(res, 'Subscription metadata mismatch');
    }

    try {
      await updateSubscriptionPrice({
        secretKey: creds.secretKey,
        stripeAccount: creds.stripeAccount,
        subscriptionId: cm.stripe_subscription_id,
        itemId: item.id,
        newPriceId: tier.stripe_price_id,
      });
    } catch (err) {
      return serverError(res, err);
    }

    return ok(res, {
      changed: true,
      // Local row will be resynced by the webhook; surface the target
      // so the UI can optimistically show the new tier name.
      targetTier: { id: tier.id, name: tier.name },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
