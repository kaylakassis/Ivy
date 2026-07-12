// Self-serve referral program ("refer a friend, you both get a free week").
//
// Every business owner can set a referral code in Settings. A new user
// who signs up with ?ref=<code> is attributed to that owner. When the
// referred user makes their first payment after the trial, BOTH sides earn
// one free week - applied as a credit to each one's Stripe customer balance
// so their next weekly invoice is waived. Stacks for the referrer: N
// conversions = N free weeks.
//
// This is intentionally SEPARATE from the admin `affiliates` program
// (paid partners, revenue dashboards). Both can read the same ?ref=
// param at signup; signup tries affiliate attribution and referral
// attribution independently.
import { sql } from './db.js';
import { platformStripeSecret, applyCustomerCredit } from './stripe.js';
import { notifyReferralReward } from './subscriptionNotify.js';

// Referral credit, in cents = one free week. Defaults to 899 (= $8.99, the
// current weekly price in src/lib/pricing.js IVY_PRICE); keep the two in sync.
// Override with IVY_REFERRAL_REWARD_CENTS if the reward should differ from one
// week's price. This is a payout amount (a business decision), not a price
// display.
const REWARD_CENTS = parseInt(process.env.IVY_REFERRAL_REWARD_CENTS || '899', 10);

// Codes are uppercased, alphanumeric + dashes, 3-40 chars. Returns the
// normalized code or null if it can't be made valid.
export function normalizeCode(raw) {
  if (!raw) return null;
  const c = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(c)) return null;
  return c;
}

// Reserved-ish words that would collide with admin affiliate codes or
// look like system values. Cheap denylist; uniqueness index does the
// real enforcement.
const BLOCKED = new Set(['Ivy OS', 'ADMIN', 'SUPPORT', 'NULL', 'NONE', 'TEST']);

// Read the owner's current referral code (or null).
export async function getCode(userId) {
  const r = await sql`SELECT code FROM referral_codes WHERE user_id = ${userId}`;
  return r.rows[0]?.code || null;
}

// Set / change the owner's referral code. Returns { ok, code } or
// { ok:false, error }. Enforces format, denylist, and global
// uniqueness (case-insensitive).
export async function setCode(userId, raw) {
  const code = normalizeCode(raw);
  if (!code) return { ok: false, error: 'Code must be 3-40 letters, numbers, or dashes.' };
  if (BLOCKED.has(code)) return { ok: false, error: 'That code is reserved. Pick another.' };

  // Reject if another user already owns this code (case-insensitive).
  const clash = await sql`
    SELECT user_id FROM referral_codes WHERE UPPER(code) = ${code} AND user_id <> ${userId}
  `;
  if (clash.rows.length > 0) return { ok: false, error: 'That code is taken. Try another.' };

  // Also avoid colliding with an admin affiliate code so ?ref= stays
  // unambiguous.
  try {
    const aff = await sql`SELECT id FROM affiliates WHERE UPPER(code) = ${code} LIMIT 1`;
    if (aff.rows.length > 0) return { ok: false, error: 'That code is taken. Try another.' };
  } catch { /* affiliates table missing on a partial schema - ignore */ }

  await sql`
    INSERT INTO referral_codes (user_id, code)
    VALUES (${userId}, ${code})
    ON CONFLICT (user_id) DO UPDATE SET code = ${code}, updated_at = NOW()
  `;
  return { ok: true, code };
}

// Resolve a ?ref= code to the referring owner's user id, or null.
export async function resolveCodeToReferrer(rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return null;
  const r = await sql`SELECT user_id FROM referral_codes WHERE UPPER(code) = ${code} LIMIT 1`;
  return r.rows[0]?.user_id || null;
}

// Record a referred signup. Called from signup AFTER the user row
// exists. No-op if the code doesn't resolve, or if the referrer is the
// new user themselves (self-referral), or if a referral row already
// exists for this user.
export async function recordReferralSignup({ referredUserId, rawCode }) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'no-code' };
  const referrerUserId = await resolveCodeToReferrer(code);
  if (!referrerUserId) return { ok: false, reason: 'unknown-code' };
  if (referrerUserId === referredUserId) return { ok: false, reason: 'self-referral' };
  await sql`
    INSERT INTO referrals (referrer_user_id, referred_user_id, code)
    VALUES (${referrerUserId}, ${referredUserId}, ${code})
    ON CONFLICT (referred_user_id) DO NOTHING
  `;
  return { ok: true };
}

// Called when a user (the REFERRED one) first becomes paying. Stamps
// converted_at on their referral, then rewards BOTH sides one free week:
//   - the REFERRER (only succeeds if they're an active paying owner with a
//     Stripe customer; otherwise stays pending for their own next sweep), and
//   - the REFERRED user themselves (immediate - they just paid, so they're
//     active with a Stripe customer).
// Safe to call on every payment_succeeded - it no-ops once converted_at is
// already set, and each grant is claim-first idempotent.
export async function markReferralConverted(referredUserId) {
  if (!referredUserId) return { converted: false };
  const upd = await sql`
    UPDATE referrals SET converted_at = COALESCE(converted_at, NOW())
    WHERE referred_user_id = ${referredUserId} AND converted_at IS NULL
    RETURNING referrer_user_id
  `;
  if (upd.rows.length === 0) return { converted: false };
  const referrerUserId = upd.rows[0].referrer_user_id;
  // Reward the referrer immediately; if they're not active yet, the reward
  // stays pending and their own next payment will sweep it.
  await grantPendingReferralCredits(referrerUserId).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn('[referrals] grant on conversion failed:', e.message);
  });
  // Reward the referred user their own free week (welcome gift).
  await grantReferredUserReward(referredUserId).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn('[referrals] referred reward on conversion failed:', e.message);
  });
  return { converted: true };
}

// Grant any converted-but-unrewarded referral rewards to this owner,
// IF they are an active paying owner with a Stripe customer. Called
// (a) at the moment a referee converts, and (b) on the referrer's OWN
// payment_succeeded (sweeps rewards that were pending because the
// referrer wasn't active when their referee converted). Each pending
// referral grants one week's credit.
export async function grantPendingReferralCredits(referrerUserId) {
  if (!referrerUserId) return { granted: 0 };

  // Must be an active paying owner with a Stripe customer to receive
  // a balance credit.
  const wr = await sql`
    SELECT id, stripe_customer_id, subscription_status
    FROM workspaces WHERE owner_id = ${referrerUserId} LIMIT 1
  `;
  const ws = wr.rows[0];
  if (!ws || ws.subscription_status !== 'active' || !ws.stripe_customer_id) {
    return { granted: 0, reason: 'referrer-not-active' };
  }

  const pending = await sql`
    SELECT id FROM referrals
    WHERE referrer_user_id = ${referrerUserId}
      AND converted_at IS NOT NULL AND rewarded_at IS NULL
  `;
  if (pending.rows.length === 0) return { granted: 0 };

  const secretKey = platformStripeSecret();
  if (!secretKey) return { granted: 0, reason: 'no-stripe' };

  let granted = 0;
  for (const row of pending.rows) {
    try {
      // Claim the row FIRST (conditional update) so two concurrent
      // webhook deliveries can't double-credit the same referral.
      // eslint-disable-next-line no-await-in-loop
      const claim = await sql`
        UPDATE referrals SET rewarded_at = NOW(), reward_cents = ${REWARD_CENTS}
        WHERE id = ${row.id} AND rewarded_at IS NULL
        RETURNING id
      `;
      if (claim.rows.length === 0) continue; // lost the race
      // eslint-disable-next-line no-await-in-loop
      await applyCustomerCredit({
        secretKey,
        customerId: ws.stripe_customer_id,
        amountCents: REWARD_CENTS,
        description: 'Ivy OS referral reward - one free week',
      });
      granted++;
      // Best-effort: tell the referrer they earned a free week. Never blocks
      // or rolls back the credit if the notification fails.
      notifyReferralReward({ workspaceId: ws.id, variant: 'referrer', weeks: 1 })
        .catch((e) => console.warn('[referrals] referrer notify failed:', e.message));
    } catch (err) {
      // Stripe credit failed AFTER we claimed the row - roll the claim
      // back so a later sweep retries it.
      // eslint-disable-next-line no-await-in-loop
      const rolledBack = await sql`UPDATE referrals SET rewarded_at = NULL, reward_cents = NULL WHERE id = ${row.id}`
        .then(() => true)
        .catch((rbErr) => {
          // If BOTH the credit AND its rollback fail, the row is stuck
          // marked-rewarded with no credit applied - a silently-lost
          // free week. This must be loud so it can be reconciled by
          // hand; do NOT swallow it.
          // eslint-disable-next-line no-console
          console.error(`[referrals] CRITICAL: rollback failed for referral ${row.id} - reward marked granted but no Stripe credit applied:`, rbErr.message);
          return false;
        });
      // eslint-disable-next-line no-console
      console.error('[referrals] credit apply failed (rolled back:', rolledBack, '):', err.message);
    }
  }
  return { granted };
}

// Grant the REFERRED user their own free week at conversion. Unlike the
// referrer, they just made their first payment, so they're active with a
// Stripe customer by definition - no pending state. Claim-first on
// referred_rewarded_at so two concurrent webhook deliveries can't
// double-credit, with the same rollback-on-Stripe-failure discipline as the
// referrer grant.
export async function grantReferredUserReward(referredUserId) {
  if (!referredUserId) return { granted: 0 };
  const wr = await sql`
    SELECT r.id AS referral_id, w.id AS workspace_id, w.stripe_customer_id
    FROM referrals r
    JOIN workspaces w ON w.owner_id = r.referred_user_id
    WHERE r.referred_user_id = ${referredUserId}
      AND r.converted_at IS NOT NULL AND r.referred_rewarded_at IS NULL
    LIMIT 1
  `;
  const row = wr.rows[0];
  if (!row || !row.stripe_customer_id) return { granted: 0, reason: 'not-eligible' };

  const secretKey = platformStripeSecret();
  if (!secretKey) return { granted: 0, reason: 'no-stripe' };

  // Claim the row first so concurrent deliveries can't double-credit.
  const claim = await sql`
    UPDATE referrals SET referred_rewarded_at = NOW(), referred_reward_cents = ${REWARD_CENTS}
    WHERE id = ${row.referral_id} AND referred_rewarded_at IS NULL
    RETURNING id
  `;
  if (claim.rows.length === 0) return { granted: 0 }; // lost the race
  try {
    await applyCustomerCredit({
      secretKey,
      customerId: row.stripe_customer_id,
      amountCents: REWARD_CENTS,
      description: 'Ivy OS referral welcome gift - one free week',
    });
  } catch (err) {
    // Roll the claim back so a later run retries; if the rollback also
    // fails, log loudly (a silently-lost free week) for manual reconciliation.
    await sql`UPDATE referrals SET referred_rewarded_at = NULL, referred_reward_cents = NULL WHERE id = ${row.referral_id}`
      .catch((rbErr) => {
        // eslint-disable-next-line no-console
        console.error(`[referrals] CRITICAL: referred-side rollback failed for referral ${row.referral_id}:`, rbErr.message);
      });
    // eslint-disable-next-line no-console
    console.error('[referrals] referred credit apply failed:', err.message);
    return { granted: 0 };
  }
  // Best-effort welcome-gift notification.
  notifyReferralReward({ workspaceId: row.workspace_id, variant: 'referred', weeks: 1 })
    .catch((e) => console.warn('[referrals] referred notify failed:', e.message));
  return { granted: 1 };
}

// Show the referrer a friendly-but-privacy-safe label for each person they
// referred: their first name if we have it, else a masked email, else a
// generic fallback. Never expose a full email address.
function maskName(name, email) {
  const fn = (name || '').trim().split(/\s+/)[0];
  if (fn) return fn;
  const addr = String(email || '');
  const at = addr.indexOf('@');
  if (at > 0) {
    const user = addr.slice(0, at);
    const domain = addr.slice(at);
    const shown = user.slice(0, 2);
    return `${shown}${'*'.repeat(Math.max(1, user.length - shown.length))}${domain}`;
  }
  return 'A friend';
}

// Stats for the owner's Settings panel.
export async function getReferralStats(userId) {
  const { rows } = await sql`
    SELECT
      COUNT(*)::int                                          AS referred,
      COUNT(*) FILTER (WHERE converted_at IS NOT NULL)::int  AS converted,
      COUNT(*) FILTER (WHERE rewarded_at IS NOT NULL)::int   AS rewarded,
      COALESCE(SUM(reward_cents) FILTER (WHERE rewarded_at IS NOT NULL), 0)::int AS rewarded_cents
    FROM referrals WHERE referrer_user_id = ${userId}
  `;
  return rows[0] || { referred: 0, converted: 0, rewarded: 0, rewarded_cents: 0 };
}

// Per-referral history for the portal: newest first, identity masked, with a
// derived status (invited → subscribed → rewarded).
export async function listReferrals(userId, { limit = 50 } = {}) {
  const { rows } = await sql`
    SELECT r.referred_user_id, r.signed_up_at, r.converted_at, r.rewarded_at,
           u.email, u.name
    FROM referrals r
    LEFT JOIN users u ON u.id = r.referred_user_id
    WHERE r.referrer_user_id = ${userId}
    ORDER BY r.signed_up_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    name: maskName(r.name, r.email),
    signedUpAt: r.signed_up_at,
    convertedAt: r.converted_at,
    rewardedAt: r.rewarded_at,
    status: r.rewarded_at ? 'rewarded' : (r.converted_at ? 'subscribed' : 'invited'),
  }));
}

export { REWARD_CENTS };
