// Shared win-back offer logic. Two callers:
//   • api/cron/winback.js          - daily dwell-based sweep (email/push
//                                     to owners who left without paying).
//   • api/billing/winback-offer.js - on-demand, fired the moment an owner
//                                     ABANDONS Stripe checkout and lands
//                                     back on the wall (?subscribed=cancelled).
//
// Both go through ensureWinbackOffer so the coupon terms, the
// one-offer-per-workspace guarantee, and the race handling live in one
// place.
//
// PROMO CODE STRATEGY — two modes:
//   1. STATIC (preferred when env vars are set): operator pre-creates a
//      single coupon + promotion code in the Stripe dashboard (e.g.
//      "HEADSTART30") and points us at it via WINBACK_STRIPE_COUPON_ID +
//      WINBACK_PROMO_CODE. We re-use that one code for every win-back
//      email, never mint per-workspace. Simpler, easier to track, and
//      the operator can edit the offer in Stripe without a redeploy.
//   2. DYNAMIC (fallback): mint a fresh per-workspace coupon + promo
//      code via the Stripe API every time. One-redemption-per-code so
//      it can't be shared. Used when env vars aren't set.
//
// Either way, workspaces.winback_offer_sent_at is stamped so we still
// honor the "one offer per workspace, ever" rule.
import { sql } from './db.js';
import { createWinbackCoupon } from './stripe.js';

export const WINBACK = {
  PERCENT_OFF:      30,   // % off the monthly price
  DURATION_MONTHS:  3,    // how many invoices the discount covers
  OFFER_VALID_DAYS: 14,   // how long the coupon stays usable
  // Cron: wait this long after first-paywall-seen before offering. 24h
  // is enough room for an owner who would convert organically to do so
  // (most who convert do it in the same session). Past that, the
  // discount nudge is exactly the point of win-back.
  DWELL_DAYS:       1,    // cron: wait this long after first-paywall-seen
  // Sized for ~100K active workspaces. Each offer mints a Stripe coupon
  // so the API-call cost matters; this is a daily ceiling.
  MAX_PER_RUN:      1000,
};

// Static-code mode is on when BOTH env vars are set. Either one missing
// → fall back to per-workspace minting (the old behavior).
function staticOffer() {
  const couponId = (process.env.WINBACK_STRIPE_COUPON_ID || '').trim();
  const promoCode = (process.env.WINBACK_PROMO_CODE || '').trim();
  if (!couponId || !promoCode) return null;
  return { couponId, promoCode };
}

// Idempotently ensure a win-back offer exists for this workspace and
// return it. Shapes:
//   { couponId, promoCode, percentOff, durationMonths, expiresAt, fresh }
//     fresh=true  → we just minted it (caller may send email/push)
//     fresh=false → a live offer already existed; re-read, don't re-email
//   null → workspace already had an offer that has since EXPIRED (one
//          offer per workspace, ever - we don't renew), or minting failed.
//
// Concurrency-safe: the stamp UPDATE carries `winback_offer_sent_at IS
// NULL`, so two racers (cron + on-demand endpoint at the same instant)
// can't both mint - the loser re-reads the winner's row.
export async function ensureWinbackOffer({ secretKey, workspaceId }) {
  const { rows } = await sql`
    SELECT winback_offer_sent_at, winback_coupon_id,
           winback_promo_code, winback_expires_at
      FROM workspaces WHERE id = ${workspaceId}
  `;
  const row = rows[0];
  if (!row) return null;

  // Fast path: a non-expired offer already exists - return it untouched,
  // no Stripe call, no email (fresh=false).
  if (row.winback_coupon_id && row.winback_expires_at
      && new Date(row.winback_expires_at).getTime() > Date.now()) {
    return offerFrom(row, false);
  }
  // Already offered once (even if now expired) → one-and-done.
  if (row.winback_offer_sent_at) return null;

  // STATIC mode — re-use the operator-configured coupon. No Stripe API
  // call needed; just stamp the workspace + return.
  const fixed = staticOffer();
  let couponId, promoCode;
  if (fixed) {
    couponId  = fixed.couponId;
    promoCode = fixed.promoCode;
  } else {
    // DYNAMIC mode — mint per-workspace coupon + single-use promo code.
    const minted = await createWinbackCoupon({
      secretKey, workspaceId,
      percentOff: WINBACK.PERCENT_OFF,
      durationMonths: WINBACK.DURATION_MONTHS,
    });
    couponId  = minted.couponId;
    promoCode = minted.promoCode;
  }
  const expiresAt = new Date(Date.now() + WINBACK.OFFER_VALID_DAYS * 86_400_000);
  const stamped = await sql`
    UPDATE workspaces SET
      winback_offer_sent_at = NOW(),
      winback_coupon_id     = ${couponId},
      winback_promo_code    = ${promoCode},
      winback_expires_at    = ${expiresAt}
    WHERE id = ${workspaceId} AND winback_offer_sent_at IS NULL
    RETURNING winback_coupon_id, winback_promo_code, winback_expires_at
  `;
  if (stamped.rows.length === 0) {
    // Lost the race - return whatever the winner wrote, no email.
    const r2 = await sql`
      SELECT winback_coupon_id, winback_promo_code, winback_expires_at
        FROM workspaces WHERE id = ${workspaceId}
    `;
    return r2.rows[0]?.winback_coupon_id ? offerFrom(r2.rows[0], false) : null;
  }
  return {
    couponId, promoCode,
    percentOff: WINBACK.PERCENT_OFF,
    durationMonths: WINBACK.DURATION_MONTHS,
    expiresAt, fresh: true,
  };
}

function offerFrom(row, fresh) {
  return {
    couponId: row.winback_coupon_id,
    promoCode: row.winback_promo_code,
    percentOff: WINBACK.PERCENT_OFF,
    durationMonths: WINBACK.DURATION_MONTHS,
    expiresAt: row.winback_expires_at,
    fresh,
  };
}
