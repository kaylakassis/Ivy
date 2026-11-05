// POST /api/billing/checkout
// Creates a Stripe Checkout Session for the Ivy subscription and returns
// its URL. Frontend redirects there; on success Stripe redirects back to
// /?subscribed=1 and the webhook + sync endpoint together flip the
// workspace's subscription_status to active.
//
// Reuses an existing Stripe customer for this workspace if one is already
// stored (e.g. owner cancelled and is re-subscribing) so card/billing
// history stays attached to one customer record, and creates it up front
// (once) when there is none.
//
// Never a second plan: 409 { error, code, provider, manageUrl } when the
// workspace already pays through Stripe (confirmed with Stripe) or Apple.
// Never a second session: a repeat click for the same offer gets the open
// session back, a different offer expires the old one (one payable checkout
// per workspace), and creates carry a short-window idempotency key.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import {
  createSubscriptionCheckoutSession, platformStripeSecret, fetchCheckoutSession, expireCheckoutSession,
} from '../_lib/stripe.js';
import { getWaitlistCouponId } from '../_lib/waitlistCoupon.js';
import { TRIAL_DAYS } from '../_lib/billing.js';
import {
  checkoutBlock, ensureIvyCustomer, hasUsedTrial, recordTrialClaim,
  fetchSubscriptionOrNull, LIVE_STRIPE_STATUSES, MANAGE_BILLING_PATH,
} from '../_lib/billingGuard.js';
import { enforce } from '../_lib/rate-limit.js';
import { appUrl } from '../_lib/tokens.js';
import { evictWorkspaceGateCache } from '../_lib/workspaceGate.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

// Same-offer clicks inside this window share one Stripe idempotency key, so
// even two requests racing past the stored-session check get one session.
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

function refuse(res, block) {
  return res.status(409).json({
    error: block.message,
    code: block.code,
    provider: block.provider,
    manageUrl: block.manageUrl,
  });
}

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
      const eligibleForTrial = !w.trial_started_at && !w.trial_ends_at && !w.converted_at
        && !(await hasUsedTrial(user.email));
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
      await recordTrialClaim({ email: user.email, workspaceId, source: 'no-card' });
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
    if (await enforce(req, res, [{ key: `billing-checkout:user:${user.id}`, max: 20, windowSeconds: 10 * 60 }])) return;
    const workspaceId = await ensureWorkspace(user.id);

    const { rows } = await sql`
      SELECT stripe_customer_id, stripe_subscription_id, subscription_status, subscription_source,
             subscription_period_end, cancel_at_period_end,
             winback_coupon_id, winback_expires_at, waitlist_discount_at,
             trial_started_at, trial_ends_at, converted_at,
             billing_checkout_session_id, billing_checkout_key, billing_checkout_url
        FROM workspaces WHERE id = ${workspaceId}
    `;
    const w = rows[0];
    // Never sell a second plan. A workspace already paying (or trialing)
    // through Stripe, or paying through Apple, is refused with where to
    // manage the plan it has. The Stripe case is confirmed with Stripe, so a
    // missed cancellation webhook can't lock anyone out.
    const block = await checkoutBlock({ ws: w, secretKey });
    if (block) return refuse(res, block);

    // Card-backed free trial, first-timers only. Eligible = the workspace has
    // never started a trial of any kind (old no-card OR new card-backed) and
    // never converted, and this person never had a trial on an earlier
    // account (deleting the account and signing up again with the same
    // email does not bring the trial back). Lapsed/returning owners
    // subscribe at full price (no second free trial).
    const eligibleForTrial = !w?.trial_started_at && !w?.trial_ends_at && !w?.converted_at
      && !(await hasUsedTrial(user.email));

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

    const trialDays = eligibleForTrial ? TRIAL_DAYS : undefined;
    const offerKey = `${plan}:${trialDays || 0}:${couponId || '-'}`;

    // Double click, second tab, retry: hand back the session already open
    // for this exact offer instead of making another one.
    if (w?.billing_checkout_session_id) {
      const prev = await fetchCheckoutSession({ secretKey, sessionId: w.billing_checkout_session_id }).catch(() => null);
      if (prev?.status === 'open' && w.billing_checkout_key === offerKey && (prev.url || w.billing_checkout_url)) {
        return ok(res, { url: prev.url || w.billing_checkout_url, reused: true });
      }
      if (prev?.status === 'complete' && prev.subscription) {
        // Paid a moment ago in another tab; the webhook just hasn't landed.
        const subId = typeof prev.subscription === 'object' ? prev.subscription.id : prev.subscription;
        const live = typeof prev.subscription === 'object'
          ? prev.subscription
          : await fetchSubscriptionOrNull(secretKey, subId);
        if (live && LIVE_STRIPE_STATUSES.has(live.status)) {
          return refuse(res, {
            code: 'already_subscribed', provider: 'stripe', manageUrl: MANAGE_BILLING_PATH,
            message: 'Your payment already went through. Ivy unlocks in a moment; refresh the page if it has not.',
          });
        }
      }
    }

    // One Stripe customer per workspace, created once and reused by every
    // checkout (before, each session minted its own customer from the email).
    const customerId = await ensureIvyCustomer({
      secretKey, workspaceId, email: user.email, name: user.name,
    });

    const base = appUrl();
    // The key covers everything that shapes the session plus the session
    // it replaces, so a retry inside the window replays the same session,
    // while switching plan (or coming back after we expired one) gets a
    // fresh one rather than a replay of an expired session.
    const windowStart = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
    const idempotencyKey = `ivy-checkout:${workspaceId}:${offerKey}:${customerId}:${w?.billing_checkout_session_id || 'none'}:${windowStart}`;
    const createSession = () => createSubscriptionCheckoutSession({
      secretKey, priceId,
      customerId,
      customerEmail: null,
      workspaceId,
      successUrl: `${base}/?subscribed=1&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl:  `${base}/?subscribed=cancelled`,
      couponId,
      // First-timers start a card-on-file free trial; winback (already-trialed)
      // and returning users go straight to a paid subscription.
      trialDays,
      idempotencyKey,
    });
    let session;
    try {
      session = await createSession();
    } catch (err) {
      // Stripe answers 409 while an identical keyed request is still in
      // flight (two clicks at the same instant). Wait a beat and replay.
      if (err.status !== 409) throw err;
      await new Promise((r) => setTimeout(r, 800));
      session = await createSession();
    }

    // Remember it, and atomically learn which session it replaces. The row
    // lock serialises two tabs racing here, so each sees the other's
    // session as the one to close.
    const swap = await sql`
      UPDATE workspaces w SET
        billing_checkout_session_id = ${session.id},
        billing_checkout_key        = ${offerKey},
        billing_checkout_url        = ${session.url || null},
        billing_checkout_at         = NOW()
      FROM (SELECT id, billing_checkout_session_id AS old_id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE) o
      WHERE w.id = o.id
      RETURNING o.old_id
    `;
    const replaced = swap.rows[0]?.old_id;
    if (replaced && replaced !== session.id) {
      // Only one checkout per workspace may stay payable.
      await expireCheckoutSession({ secretKey, sessionId: replaced }).catch(() => {});
    }

    return ok(res, { url: session.url });
  } catch (err) {
    return serverError(res, err);
  }
}
