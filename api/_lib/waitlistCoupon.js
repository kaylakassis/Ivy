// Resolves the single shared "waitlist launch" Stripe coupon (20% off,
// 12 months), minting it once and caching its id in app_settings so the
// Stripe round-trip happens at most once across the whole platform.
//
// Used by:
//   • the admin launch toggle (lazily, when flipping to 'open') so the
//     discount is live before the announcement blast goes out, and
//   • billing/checkout.js (defensively) in case the toggle path was
//     skipped (e.g. launched before this feature shipped).
import { sql } from './db.js';
import { createWaitlistCoupon, platformStripeSecret } from './stripe.js';

export const WAITLIST_PERCENT_OFF = 20;
export const WAITLIST_DURATION_MONTHS = 12;

// Returns the coupon id, or null if Stripe isn't configured (no secret
// key). Idempotent + cached: reads app_settings.waitlist_coupon_id first.
export async function ensureWaitlistCoupon() {
  try {
    const { rows } = await sql`SELECT waitlist_coupon_id FROM app_settings WHERE id = 1`;
    const cached = rows[0]?.waitlist_coupon_id;
    if (cached) return cached;

    const secretKey = platformStripeSecret();
    if (!secretKey) return null; // Stripe not configured yet — caller skips the discount

    const { couponId } = await createWaitlistCoupon({
      secretKey,
      percentOff: WAITLIST_PERCENT_OFF,
      durationMonths: WAITLIST_DURATION_MONTHS,
    });
    await sql`UPDATE app_settings SET waitlist_coupon_id = ${couponId} WHERE id = 1`;
    return couponId;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[waitlistCoupon] ensure failed:', err.message);
    return null;
  }
}

// Cheap read-only lookup (no minting) for checkout's hot path — if the
// coupon was already created we use it; if not, we mint lazily.
export async function getWaitlistCouponId() {
  try {
    const { rows } = await sql`SELECT waitlist_coupon_id FROM app_settings WHERE id = 1`;
    return rows[0]?.waitlist_coupon_id || (await ensureWaitlistCoupon());
  } catch {
    return null;
  }
}
