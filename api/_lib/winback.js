// Shared win-back offer logic. Two callers:
//   • api/cron/winback.js          — daily dwell-based sweep (email/push
//                                     to owners who left without paying).
//   • api/billing/winback-offer.js — on-demand, fired the moment an owner
//                                     ABANDONS Stripe checkout and lands
//                                     back on the wall (?subscribed=cancelled).
//
// Both go through ensureWinbackOffer so the coupon terms, the
// one-offer-per-workspace guarantee, and the race handling live in one
// place.
import { sql } from './db.js';
import { createWinbackCoupon } from './stripe.js';

export const WINBACK = {
  PERCENT_OFF:      30,   // % off the monthly price
  DURATION_MONTHS:  3,    // how many invoices the discount covers
  OFFER_VALID_DAYS: 14,   // how long the coupon stays usable
  DWELL_DAYS:       3,    // cron: wait this long after first-paywall-seen
  MAX_PER_RUN:      200,  // cron: daily coupon-creation ceiling
};

// Idempotently ensure a win-back offer exists for this workspace and
// return it. Shapes:
//   { couponId, promoCode, percentOff, durationMonths, expiresAt, fresh }
//     fresh=true  → we just minted it (caller may send email/push)
//     fresh=false → a live offer already existed; re-read, don't re-email
//   null → workspace already had an offer that has since EXPIRED (one
//          offer per workspace, ever — we don't renew), or minting failed.
//
// Concurrency-safe: the stamp UPDATE carries `winback_offer_sent_at IS
// NULL`, so two racers (cron + on-demand endpoint at the same instant)
// can't both mint — the loser re-reads the winner's row.
export async function ensureWinbackOffer({ secretKey, workspaceId }) {
  const { rows } = await sql`
    SELECT winback_offer_sent_at, winback_coupon_id,
           winback_promo_code, winback_expires_at
      FROM workspaces WHERE id = ${workspaceId}
  `;
  const row = rows[0];
  if (!row) return null;

  // Fast path: a non-expired offer already exists — return it untouched,
  // no Stripe call, no email (fresh=false).
  if (row.winback_coupon_id && row.winback_expires_at
      && new Date(row.winback_expires_at).getTime() > Date.now()) {
    return offerFrom(row, false);
  }
  // Already offered once (even if now expired) → one-and-done.
  if (row.winback_offer_sent_at) return null;

  // Never offered: mint + stamp.
  const { couponId, promoCode } = await createWinbackCoupon({
    secretKey, workspaceId,
    percentOff: WINBACK.PERCENT_OFF,
    durationMonths: WINBACK.DURATION_MONTHS,
  });
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
    // Lost the race — return whatever the winner wrote, no email.
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
