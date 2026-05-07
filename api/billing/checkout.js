// POST /api/billing/checkout
// Creates a Stripe Checkout Session for the THRYVE subscription and returns
// its URL. Frontend redirects there; on success Stripe redirects back to
// /?subscribed=1 and the webhook + sync endpoint together flip the
// workspace's subscription_status to active.
//
// Reuses an existing Stripe customer for this workspace if one is already
// stored (e.g. owner cancelled and is re-subscribing) so card/billing
// history stays attached to one customer record.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { createSubscriptionCheckoutSession, platformStripeSecret } from '../_lib/stripe.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const secretKey = platformStripeSecret();
    const priceId   = process.env.THRYVE_STRIPE_PRICE_ID;
    if (!secretKey || !priceId) {
      return badRequest(res, 'Subscription billing is not configured yet — set STRIPE_SECRET_KEY (the Vercel Stripe integration provides this) and THRYVE_STRIPE_PRICE_ID.');
    }

    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const { rows } = await sql`
      SELECT stripe_customer_id, subscription_status
      FROM workspaces WHERE id = ${workspaceId}
    `;
    const w = rows[0];
    if (w?.subscription_status === 'active') {
      return badRequest(res, 'You already have an active subscription. Open the billing portal to manage it.');
    }

    const base = appUrl();
    const session = await createSubscriptionCheckoutSession({
      secretKey, priceId,
      customerId:    w?.stripe_customer_id || null,
      customerEmail: w?.stripe_customer_id ? null : user.email,
      workspaceId,
      successUrl: `${base}/?subscribed=1&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${base}/?subscribed=cancelled`,
    });

    return ok(res, { url: session.url });
  } catch (err) {
    return serverError(res, err);
  }
}
