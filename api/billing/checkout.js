// POST /api/billing/checkout
// Creates a Stripe Checkout Session for the Ivy subscription and returns
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
import { getWaitlistCouponId } from '../_lib/waitlistCoupon.js';
import { TRIAL_DAYS } from '../_lib/billing.js';
import { appUrl } from '../_lib/tokens.js';
import { evictWorkspaceGateCache } from '../_lib/workspaceGate.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const secretKey = platformStripeSecret();
    const monthlyPriceId = process.env.IVY_STRIPE_PRICE_ID;
    // Graceful fallback: Stripe isn't configured yet. Without a fallback,
    // brand-new signups would be locked out (their workspace is `incomplete`
    // and the only way out of the paywall is Checkout, which doesn't exist).
    // We grant a no-card trial - same length as the card-backed one - so the
    // app stays usable while the operator finishes wiring Stripe. Once
    // STRIPE_SECRET_KEY + IVY_STRIPE_PRICE_ID are set, subsequent signups go
    // through Checkout as designed.
    if (!secretKey || !monthlyPriceId) {
      const user = await requireUser(req, res);
      if (!user) return;
      const workspaceId = await ensureWorkspace(user.id);
      const { rows } = await sql`
        SELECT subscription_status, trial_started_at, trial_ends_at, converted_at
          FROM workspaces WHERE id = ${workspaceId}
      `;
      const w = rows[0] || {};
      const now = Date.now();
      const stillTrialing = w.subscription_status === 'trialing'
        && w.trial_ends_at && new Date(w.trial_ends_at).getTime() > now;
      if (stillTrialing) return ok(res, { url: null, trialStarted: true, alreadyActive: true });
      const eligibleForTrial = !w.trial_started_at && !w.trial_ends_at && !w.converted_at;
      if (!eligibleForTrial) {
        return badRequest(res, 'Subscription billing is not configured yet. Please contact support to subscribe.');
      }
      await sql`
        UPDATE workspaces SET
          subscription_status = 'trialing',
          trial_started_at = NOW(),
          trial_ends_at = NOW() + (${TRIAL_DAYS}::int || ' days')::interval
        WHERE id = ${workspaceId}
      `;
      evictWorkspaceGateCache(workspaceId);
      // eslint-disable-next-line no-console
      console.warn('[billing/checkout] Stripe not configured — granted no-card fallback trial for workspace', workspaceId);
      return ok(res, { url: null, trialStarted: true, fallback: 'no-card' });
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
             winback_coupon_id, winback_expires_at, waitlist_discount_at,
             trial_started_at, trial_ends_at, converted_at
        FROM workspaces WHERE id = ${workspaceId}
    `;
    const w = rows[0];
    if (w?.subscription_status === 'active') {
      return badRequest(res, 'You already have an active subscription. Open the billing portal to manage it.');
    }

    // Card-backed free trial, first-timers only. Eligible = the workspace has
    // never started a trial of any kind (old no-card OR new card-backed) and
    // never converted. Lapsed/returning owners subscribe at full price (no
    // second free trial).
    const eligibleForTrial = !w?.trial_started_at && !w?.trial_ends_at && !w?.converted_at;

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

    // Waitlist launch discount (20% off, 12 months): pre-applied when this
    // workspace was stamped eligible at signup (its email matched the
    // waitlist). Minted once + cached; never exposed as a typed code - the
    // server-side email match is the exclusivity. Unlike the monthly-only
    // win-back, this applies to both monthly and annual (12 repeating
    // months covers either cleanly). Win-back wins if both are present:
    // it's time-boxed/expiring, the waitlist boolean is durable and waits.
    const waitlistCoupon = w?.waitlist_discount_at ? await getWaitlistCouponId() : null;
    const couponId = winbackCoupon ?? waitlistCoupon;

    const base = appUrl();
    const session = await createSubscriptionCheckoutSession({
      secretKey, priceId,
      customerId:    w?.stripe_customer_id || null,
      customerEmail: w?.stripe_customer_id ? null : user.email,
      workspaceId,
      successUrl: `${base}/?subscribed=1&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${base}/?subscribed=cancelled`,
      couponId,
      // First-timers start a card-on-file free trial; winback (already-trialed)
      // and returning users go straight to a paid subscription.
      trialDays:  eligibleForTrial ? TRIAL_DAYS : undefined,
    });

    return ok(res, { url: session.url });
  } catch (err) {
    return serverError(res, err);
  }
}
