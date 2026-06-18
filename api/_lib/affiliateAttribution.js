// Affiliate revenue auto-population.
//
// Called from the platform billing webhook whenever a workspace lands on
// a paying state. Stamps the matching affiliate_uses row so the admin's
// affiliates dashboard reflects "real money in" without anyone having
// to flip a flag.
//
// Idempotent:
//   • became_paid_at is set the first time and never moved (keeps
//     "first-paid timestamp" stable for cohort views later).
//   • monthly_value_cents is overwritten on every call so the dashboard
//     reflects the affiliate's current MRR contribution. If you want
//     lifetime revenue per affiliate, sum each successful payment into
//     a separate events table - out of scope here.
import { sql } from './db.js';

const PLAN_FALLBACK_CENTS = parseInt(
  process.env.IVY_PLAN_MONTHLY_CENTS || '2900',  // $29/mo default
  10,
);

// Pull the monthly value (in cents) from a Stripe subscription object.
// Annual plans get divided by 12 so MRR comparisons stay apples-to-apples.
// Falls back to PLAN_FALLBACK_CENTS when the Stripe object doesn't carry
// a price (e.g. a manually-promoted workspace with no subscription_id).
export function monthlyValueCents(stripeSubscription) {
  const item = stripeSubscription?.items?.data?.[0];
  const price = item?.price;
  const unit = price?.unit_amount;
  if (typeof unit !== 'number') return PLAN_FALLBACK_CENTS;
  const interval = price?.recurring?.interval;
  const intervalCount = price?.recurring?.interval_count || 1;
  if (interval === 'year') return Math.round(unit / 12 / intervalCount);
  if (interval === 'month') return Math.round(unit / intervalCount);
  // Day/week prices are exotic; treat as monthly equivalents.
  return unit;
}

// Stamp the workspace owner's affiliate_use row if there is one. No-op
// (returns 0) when the owner wasn't referred - every workspace owner
// hits this path on each successful payment, so the early return needs
// to stay cheap.
export async function attributePayment({ workspaceId, valueCents }) {
  if (!workspaceId) return { updated: 0 };

  const wr = await sql`SELECT owner_id FROM workspaces WHERE id = ${workspaceId}`;
  const userId = wr.rows[0]?.owner_id;
  if (!userId) return { updated: 0 };

  const cents = Number.isFinite(valueCents) && valueCents > 0
    ? Math.round(valueCents)
    : PLAN_FALLBACK_CENTS;

  const r = await sql`
    UPDATE affiliate_uses SET
      became_paid_at      = COALESCE(became_paid_at, NOW()),
      monthly_value_cents = ${cents}
    WHERE referred_user_id = ${userId}
    RETURNING id
  `;
  return { updated: r.rows.length };
}
