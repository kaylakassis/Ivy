// POST /api/billing/checkout
// Creates a Stripe Checkout Session for the Ivy OS subscription and returns
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
import { readBody } from '../_lib/body.js';
import { createSubscriptionCheckoutSession, platformStripeSecret } from '../_lib/stripe.js';
import { appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const secretKey = platformStripeSecret();
    const monthlyPriceId = process.env.IVY_STRIPE_PRICE_ID;
    if (!secretKey || !monthlyPriceId) {
      return badRequest(res, 'Subscription billing is not configured yet - set STRIPE_SECRET_KEY (the Vercel Stripe integration provides this) and IVY_STRIPE_PRICE_ID.');
    }

    // Plan selection. Monthly is the default and the always-available
    // honest baseline; annual is the highlighted LTV option. We require
    // its own Stripe price id - if annual is requested but unconfigured
    // we reject rather than silently charging the monthly price.
    const body = await readBody(req).catch(() => ({}));
    const plan = body?.plan === 'annual' ? 'annual' : 'monthly';
    const annualPriceId = process.env.IVY_STRIPE_PRICE_ID_ANNUAL;
    if (plan === 'annual' && !annualPriceId) {
      return badRequest(res, 'Annual billing is not configured yet - set IVY_STRIPE_PRICE_ID_ANNUAL.');
    }
    const priceId = plan === 'annual' ? annualPriceId : monthlyPriceId;

    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const { rows } = await sql`
      SELECT stripe_customer_id, subscription_status,
             winback_coupon_id, winback_expires_at
        FROM workspaces WHERE id = ${workspaceId}
    `;
    const w = rows[0];
    if (w?.subscription_status === 'active') {
      return badRequest(res, 'You already have an active subscription. Open the billing portal to manage it.');
    }

    // Pre-apply the win-back coupon if the cron stamped one and it
    // hasn't expired. The Stripe helper drops `allow_promotion_codes`
    // automatically when a coupon is passed (Stripe rejects both at
    // once); the offer is single-use by construction (a 1-redemption
    // promotion code paired with the coupon).
    //
    // Monthly only: the win-back coupon is "30% off, repeating 3 months",
    // which maps cleanly onto monthly invoices but discounts a yearly
    // invoice oddly. Annual is already the discounted plan, so we don't
    // stack the win-back on top - the coupon waits for a monthly checkout.
    const winbackCoupon = (
      plan === 'monthly'
      && w?.winback_coupon_id
      && w?.winback_expires_at
      && new Date(w.winback_expires_at).getTime() > Date.now()
    ) ? w.winback_coupon_id : null;

    const base = appUrl();
    const session = await createSubscriptionCheckoutSession({
      secretKey, priceId,
      customerId:    w?.stripe_customer_id || null,
      customerEmail: w?.stripe_customer_id ? null : user.email,
      workspaceId,
      successUrl: `${base}/?subscribed=1&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${base}/?subscribed=cancelled`,
      couponId:   winbackCoupon,
    });

    return ok(res, { url: session.url });
  } catch (err) {
    return serverError(res, err);
  }
}
