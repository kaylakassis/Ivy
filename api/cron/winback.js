// Daily win-back drip.
//
// What this does:
//   • Finds workspaces that have HIT the paywall (paywall_first_seen_at
//     non-null) but have NEVER been offered a win-back coupon (the
//     guard: winback_offer_sent_at IS NULL).
//   • Waits a configurable dwell window after first-seen before
//     triggering - the immediate response is the wall itself; if a
//     workspace converts within DWELL_DAYS we don't burn the offer.
//   • Creates a Stripe coupon + single-use promo code per candidate,
//     stamps the workspaces row (one offer ever, OFFER_VALID_DAYS
//     expiry), and emails the offer via notifyWinbackOffer.
//
// Why a separate cron and not "fire on the deny path": fires once,
// dwell-gated, idempotent against retries - the gate has none of those
// properties.
//
// Tunables:
//   DWELL_DAYS         - days after paywall_first_seen_at before we
//                        offer. Long enough that owners who would
//                        convert organically have already done so.
//   OFFER_VALID_DAYS   - how long the coupon remains usable.
//   PERCENT_OFF        - % off Stripe applies during the discount.
//   DURATION_MONTHS    - how many monthly invoices the discount covers.
//   MAX_PER_RUN        - daily ceiling so we don't burst-create coupons
//                        if a huge backfill candidate set appears at
//                        once (e.g. after migration).
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { platformStripeSecret } from '../_lib/stripe.js';
import { ensureWinbackOffer, WINBACK } from '../_lib/winback.js';
import { notifyWinbackOffer } from '../_lib/subscriptionNotify.js';
import { notifyOwnerSafe } from '../_lib/push.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

async function handler(req, res) {
  // Same three-path auth as subscription-dunning: Vercel cron header,
  // an admin secret for manual kicks, or a super-admin session for the
  // in-app trigger button.
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    const secretKey = platformStripeSecret();
    if (!secretKey) {
      // Without Stripe configured we can't mint coupons. Treat the run
      // as a no-op rather than failing - same posture as the other
      // crons that depend on optional integrations.
      return ok(res, { offered: 0, scanned: 0, reason: 'stripe-not-configured' });
    }

    // Candidates: lapsed workspaces past the dwell window with no
    // existing offer and no live subscription. The partial index
    // idx_workspaces_winback_candidates (schema.js) makes this scan
    // O(candidates), not O(workspaces).
    //
    // Exclude sponsored accounts (user_type='sponsored' on the owner)
    // - they're comp'd and don't need a discount nudge.
    const { rows: candidates } = await sql`
      SELECT w.id AS workspace_id, w.subscription_status, w.owner_id, u.email
        FROM workspaces w
        JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
       WHERE w.winback_offer_sent_at IS NULL
         AND w.paywall_first_seen_at IS NOT NULL
         AND w.paywall_first_seen_at <= NOW() - (${WINBACK.DWELL_DAYS} || ' days')::interval
         AND w.converted_at IS NULL
         AND COALESCE(u.user_type, 'regular') NOT IN ('sponsored', 'beta')
         -- 'incomplete' is included so the funnel rework's brand-new
         -- signups (workspace defaults to 'incomplete' until trial OR
         -- subscription is committed) get the win-back nudge after
         -- bouncing off the paywall - otherwise the most receptive
         -- audience for the offer never sees it.
         AND w.subscription_status IN ('inactive', 'cancelled', 'suspended', 'trialing', 'incomplete')
         -- ...but never an owner still inside a LIVE trial (they haven't
         -- lapsed yet - don't burn their one lifetime offer).
         AND NOT (w.subscription_status = 'trialing'
                  AND w.trial_ends_at IS NOT NULL
                  AND w.trial_ends_at > NOW())
       ORDER BY w.paywall_first_seen_at ASC
       LIMIT ${WINBACK.MAX_PER_RUN}
    `;

    let offered = 0;
    for (const c of candidates) {
      try {
        // ensureWinbackOffer mints + stamps idempotently (the
        // winback_offer_sent_at IS NULL guard lives inside it). It
        // returns fresh=true only when WE minted - the on-demand
        // checkout-abandon endpoint may have raced us to this same row.
        // eslint-disable-next-line no-await-in-loop
        const offer = await ensureWinbackOffer({ secretKey, workspaceId: c.workspace_id });
        if (!offer?.fresh) continue;

        offered++;
        notifyWinbackOffer({
          workspaceId: c.workspace_id,
          percentOff: offer.percentOff,
          durationMonths: offer.durationMonths,
          promoCode: offer.promoCode,
          expiresAt: offer.expiresAt,
        }).catch((e) => console.error('[winback] notify email failed:', e?.message));
        notifyOwnerSafe({
          workspaceId: c.workspace_id,
          type: 'billing',
          payload: {
            title: `${offer.percentOff}% off - your Ivy comeback offer`,
            body: `Code ${offer.promoCode} · expires ${new Date(offer.expiresAt).toISOString().slice(0, 10)}`,
            url:  '/account?tab=billing&winback=1',
          },
        }).catch((e) => console.error('[winback] push failed:', e?.message));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[winback] offer for workspace failed:', c.workspace_id, e?.message);
      }
    }

    // Metrics get captured by the trackCron wrapper from the response
    // body below - scanned + offered land in cron_runs.metrics.
    return ok(res, { scanned: candidates.length, offered });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('winback', handler);
