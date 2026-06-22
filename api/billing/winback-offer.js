// POST /api/billing/winback-offer
//
// On-demand win-back: fired by the paywall the moment an owner ABANDONS
// Stripe checkout and lands back on the wall (?subscribed=cancelled).
// Mints (or re-reads) the workspace's one win-back coupon and returns
// its terms so the wall can show "Wait - 30% off your first 3 months"
// inline. The coupon is stamped on the workspaces row, so the very next
// Subscribe click is auto-discounted by api/billing/checkout.js.
//
// Deliberately reuses the SAME ensureWinbackOffer path as the dwell
// cron - one offer per workspace, ever - so a user who abandons checkout
// can't farm a fresh coupon by cancelling repeatedly, and the cron
// won't double-offer someone who already got the inline version.
//
// On the exempt list (api/billing/*) - never subscription-gated, because
// a walled owner must be able to reach it.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { platformStripeSecret } from '../_lib/stripe.js';
import { ensureWinbackOffer } from '../_lib/winback.js';
import { notifyWinbackOffer } from '../_lib/subscriptionNotify.js';
import { isWorkspaceActive } from '../_lib/clientPortal.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { reportError } from '../_lib/monitoring.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const secretKey = platformStripeSecret();
    if (!secretKey) return ok(res, { eligible: false, reason: 'stripe-not-configured' });

    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    // Only LAPSED, non-sponsored, never-converted owners get the offer.
    // Crucially, an owner still inside a LIVE trial who merely abandons
    // an early upgrade-checkout must NOT burn their one lifetime offer -
    // they haven't lapsed yet. isWorkspaceActive captures exactly that:
    // a live trial (or live paid / past_due grace) reads as active and
    // is excluded; an EXPIRED trial reads as inactive and qualifies.
    const { rows } = await sql`
      SELECT subscription_status, trial_ends_at, subscription_period_end, converted_at
        FROM workspaces WHERE id = ${workspaceId}
    `;
    const w = rows[0];
    const lapsed = ['inactive', 'cancelled', 'suspended', 'trialing'].includes(w?.subscription_status)
      && !isWorkspaceActive(w);
    if (user.user_type === 'sponsored' || w?.converted_at || !lapsed) {
      return ok(res, { eligible: false });
    }

    const offer = await ensureWinbackOffer({ secretKey, workspaceId });
    if (!offer) return ok(res, { eligible: false });

    // Fire the win-back email immediately on the fresh-mint path so the
    // owner gets the 30%-off code in their inbox seconds after abandoning
    // checkout - not on tomorrow's cron run. fresh=false means a prior
    // mint (cron or earlier abandon) already emailed; don't double-send.
    if (offer.fresh) {
      notifyWinbackOffer({
        workspaceId,
        percentOff: offer.percentOff,
        durationMonths: offer.durationMonths,
        promoCode: offer.promoCode,
        expiresAt: offer.expiresAt,
      }).catch((err) => {
        console.error('[winback-offer] email send failed:', err.message);
        reportError(err, { extra: { workspaceId, path: 'on-demand-winback' } });
      });
    }

    // Don't leak couponId to the client - checkout.js reads it
    // server-side from the row. The wall only needs display terms.
    return ok(res, {
      eligible: true,
      percentOff: offer.percentOff,
      durationMonths: offer.durationMonths,
      promoCode: offer.promoCode,
      expiresAt: offer.expiresAt,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
