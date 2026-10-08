// Self-serve referral program ("refer a friend, you both get a free week").
//
// Every business owner can set a referral code in Settings. A new user
// who signs up with ?ref=<code> is attributed to that owner. When the
// referred user makes their first payment after the trial, BOTH sides earn
// one free week. Stacks for the referrer: N conversions = N free weeks.
//
// Each earned week is a row on referral_reward_ledger, and how it is
// delivered depends on how the recipient pays (billingPlatform):
//   - Stripe (web checkout): a customer-balance credit, so the next weekly
//     invoice is waived. Delivered immediately.
//   - Apple (iPhone app via RevenueCat): a renewal-date extension through
//     the App Store Server API (+7 days per week). Apple allows two
//     extensions per subscription per year, so Apple weeks are banked and
//     delivered together (applyBankedAppleWeeks).
//   - Not subscribed yet: pending until their first payment on either.
//
// Conversion is detected from both the Stripe webhook
// (api/webhooks/billing.js) and the RevenueCat webhook
// (api/billing/revenuecat-webhook.js).
//
// This is intentionally SEPARATE from the admin `affiliates` program
// (paid partners, revenue dashboards). Both can read the same ?ref=
// param at signup; signup tries affiliate attribution and referral
// attribution independently.
import { sql } from './db.js';
import { platformStripeSecret, applyCustomerCredit } from './stripe.js';
import { notifyReferralReward } from './subscriptionNotify.js';
import crypto from 'node:crypto';
import {
  appleConfigured, extendRenewalDate, MAX_DAYS_PER_EXTENSION, REASON_CUSTOMER_SATISFACTION,
} from './appStoreServer.js';

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
// real enforcement. Entries MUST be all-uppercase - normalizeCode
// uppercases before the check, so a mixed-case entry can never match.
const BLOCKED = new Set(['IVY', 'ADMIN', 'SUPPORT', 'NULL', 'NONE', 'TEST']);

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

// ── Billing platform ───────────────────────────────────────────────
// How a workspace pays decides how a free week is delivered:
//   'apple'  - subscribed through the iPhone app (RevenueCat + App Store):
//              the reward is a renewal-date extension (+7 days per week).
//   'stripe' - subscribed on the web through our own Stripe checkout:
//              the reward is a customer-balance credit (next invoice waived).
//   null     - not subscribed on either yet: rewards stay pending.
// Apple wins when the current subscription came through RevenueCat
// (revenuecat_user_id + apple_original_transaction_id both set) unless the
// workspace has since moved back to Stripe (subscription_source 'stripe'
// with a Stripe customer on file).
export function billingPlatform(ws) {
  if (!ws) return null;
  const apple = !!(ws.apple_original_transaction_id && ws.revenuecat_user_id);
  const stripe = !!ws.stripe_customer_id;
  if (apple && stripe) return ws.subscription_source === 'stripe' ? 'stripe' : 'apple';
  if (apple) return 'apple';
  if (stripe) return 'stripe';
  return null;
}

async function loadWorkspaceByOwner(ownerId) {
  const r = await sql`
    SELECT id, owner_id, subscription_status, subscription_source, converted_at,
           stripe_customer_id, revenuecat_user_id, apple_original_transaction_id
    FROM workspaces WHERE owner_id = ${ownerId} LIMIT 1
  `;
  return r.rows[0] || null;
}

async function loadWorkspaceById(workspaceId) {
  const r = await sql`
    SELECT id, owner_id, subscription_status, subscription_source, converted_at,
           stripe_customer_id, revenuecat_user_id, apple_original_transaction_id
    FROM workspaces WHERE id = ${workspaceId} LIMIT 1
  `;
  return r.rows[0] || null;
}

// Is this workspace a paying owner we can deliver a reward to right now?
// Stripe: status active with a customer (unchanged from the original
// program). Apple: status active AND converted_at stamped - RevenueCat
// reports the free trial as 'active' too, and Apple will not extend a
// renewal that has not been paid for yet.
function canReceiveReward(ws) {
  const platform = billingPlatform(ws);
  if (!platform) return null;
  if (ws.subscription_status !== 'active') return null;
  if (platform === 'apple' && !ws.converted_at) return null;
  return platform;
}

// Called when a user (the REFERRED one) first becomes paying. Stamps
// converted_at on their referral, then rewards BOTH sides one free week:
//   - the REFERRER (only succeeds if they're an active paying owner on
//     Stripe or Apple; otherwise stays pending for their own next sweep), and
//   - the REFERRED user themselves (immediate - they just paid, so they're
//     active on whichever platform they paid through).
// Safe to call on every payment event - it no-ops once converted_at is
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
    console.warn('[referrals] grant on conversion failed:', e.message);
  });
  // Reward the referred user their own free week (welcome gift).
  await grantReferredUserReward(referredUserId).catch((e) => {
    console.warn('[referrals] referred reward on conversion failed:', e.message);
  });
  return { converted: true };
}

// Deliver ONE earned week to a Stripe-billed workspace: a customer-balance
// credit, recorded on the ledger row as applied. Throws on Stripe failure
// so the caller can roll the claim back.
async function applyStripeWeek({ ws, ledgerId, description }) {
  const secretKey = platformStripeSecret();
  if (!secretKey) throw new Error('no-stripe');
  await applyCustomerCredit({
    secretKey,
    customerId: ws.stripe_customer_id,
    amountCents: REWARD_CENTS,
    description,
  });
  await sql`
    UPDATE referral_reward_ledger
       SET method = 'stripe_credit', applied_at = NOW(), note = NULL
     WHERE id = ${ledgerId}
  `;
}

// Grant any converted-but-unrewarded referral rewards to this owner,
// IF they are an active paying owner on Stripe or Apple. Called
// (a) at the moment a referee converts, and (b) on the referrer's OWN
// payment event on either platform (sweeps rewards that were pending
// because the referrer wasn't active when their referee converted).
// Each pending referral earns one week on the ledger; Stripe weeks are
// credited right away, Apple weeks go through applyBankedAppleWeeks.
export async function grantPendingReferralCredits(referrerUserId) {
  if (!referrerUserId) return { granted: 0 };

  const ws = await loadWorkspaceByOwner(referrerUserId);
  const platform = canReceiveReward(ws);
  if (!platform) return { granted: 0, reason: 'referrer-not-active' };

  const pending = await sql`
    SELECT id FROM referrals
    WHERE referrer_user_id = ${referrerUserId}
      AND converted_at IS NOT NULL AND rewarded_at IS NULL
  `;
  if (pending.rows.length === 0) {
    // Nothing new, but Apple weeks banked earlier may be deliverable now.
    if (platform === 'apple') {
      const swept = await applyBankedAppleWeeks(ws.id);
      return { granted: 0, platform, appliedWeeks: swept.appliedWeeks, bankedWeeks: swept.bankedWeeks };
    }
    return { granted: 0 };
  }

  if (platform === 'stripe' && !platformStripeSecret()) return { granted: 0, reason: 'no-stripe' };

  let granted = 0;
  for (const row of pending.rows) {
    let ledgerId = null;
    try {
      // Claim the row FIRST (conditional update) so two concurrent
      // webhook deliveries can't double-credit the same referral.
      const claim = await sql`
        UPDATE referrals SET rewarded_at = NOW(), reward_cents = ${REWARD_CENTS}
        WHERE id = ${row.id} AND rewarded_at IS NULL
        RETURNING id
      `;
      if (claim.rows.length === 0) continue; // lost the race
      const led = await sql`
        INSERT INTO referral_reward_ledger (workspace_id, user_id, referral_id, side, weeks)
        VALUES (${ws.id}, ${referrerUserId}, ${row.id}, 'referrer', 1)
        ON CONFLICT (referral_id, side) DO UPDATE SET weeks = referral_reward_ledger.weeks
        RETURNING id
      `;
      ledgerId = led.rows[0]?.id || null;
      if (platform === 'stripe') {
        await applyStripeWeek({ ws, ledgerId, description: 'Ivy referral reward - one free week' });
        // Best-effort: tell the referrer they earned a free week. Never blocks
        // or rolls back the credit if the notification fails.
        notifyReferralReward({ workspaceId: ws.id, variant: 'referrer', weeks: 1, delivery: 'stripe' })
          .catch((e) => console.warn('[referrals] referrer notify failed:', e.message));
      }
      granted++;
    } catch (err) {
      // Stripe credit failed AFTER we claimed the row - roll the claim
      // (and its ledger row) back so a later sweep retries it.
      const rolledBack = await rollbackClaim({ referralId: row.id, ledgerId, side: 'referrer' });
      console.error('[referrals] credit apply failed (rolled back:', rolledBack, '):', err.message);
    }
  }

  if (platform === 'apple') {
    // Deliver what Apple allows now; the rest stays banked on the ledger.
    const swept = await applyBankedAppleWeeks(ws.id);
    if (granted > 0) {
      notifyReferralReward({
        workspaceId: ws.id, variant: 'referrer', weeks: granted,
        delivery: swept.appliedWeeks > 0 ? 'apple' : 'banked',
      }).catch((e) => console.warn('[referrals] referrer notify failed:', e.message));
    }
    return { granted, platform, appliedWeeks: swept.appliedWeeks, bankedWeeks: swept.bankedWeeks };
  }
  return { granted, platform };
}

// Undo an "earned" stamp (and its ledger row) after delivery failed, so a
// later sweep retries. If the rollback itself fails the row is stuck
// marked-earned with nothing delivered: a silently lost free week, so it
// is logged loudly for manual reconciliation instead of swallowed.
async function rollbackClaim({ referralId, ledgerId, side }) {
  try {
    if (ledgerId) await sql`DELETE FROM referral_reward_ledger WHERE id = ${ledgerId} AND applied_at IS NULL`;
    if (side === 'referrer') {
      await sql`UPDATE referrals SET rewarded_at = NULL, reward_cents = NULL WHERE id = ${referralId}`;
    } else {
      await sql`UPDATE referrals SET referred_rewarded_at = NULL, referred_reward_cents = NULL WHERE id = ${referralId}`;
    }
    return true;
  } catch (rbErr) {
    console.error(`[referrals] CRITICAL: ${side}-side rollback failed for referral ${referralId} - reward marked granted but nothing delivered:`, rbErr.message);
    return false;
  }
}

// Grant the REFERRED user their own free week at conversion. They just
// made their first payment, so they're on a platform by definition.
// Claim-first on referred_rewarded_at so two concurrent webhook deliveries
// can't double-credit, with the same rollback-on-Stripe-failure discipline
// as the referrer grant. Apple recipients get a ledger row and go through
// the Apple sweep (which banks the week if Apple cannot take it yet).
export async function grantReferredUserReward(referredUserId) {
  if (!referredUserId) return { granted: 0 };
  const wr = await sql`
    SELECT r.id AS referral_id, w.id AS workspace_id, w.subscription_status, w.subscription_source,
           w.converted_at, w.stripe_customer_id, w.revenuecat_user_id, w.apple_original_transaction_id
    FROM referrals r
    JOIN workspaces w ON w.owner_id = r.referred_user_id
    WHERE r.referred_user_id = ${referredUserId}
      AND r.converted_at IS NOT NULL AND r.referred_rewarded_at IS NULL
    LIMIT 1
  `;
  const row = wr.rows[0];
  if (!row) return { granted: 0, reason: 'not-eligible' };
  const ws = { ...row, id: row.workspace_id };
  const platform = billingPlatform(ws);
  if (!platform) return { granted: 0, reason: 'not-eligible' };
  if (platform === 'stripe' && !platformStripeSecret()) return { granted: 0, reason: 'no-stripe' };

  // Claim the row first so concurrent deliveries can't double-credit.
  const claim = await sql`
    UPDATE referrals SET referred_rewarded_at = NOW(), referred_reward_cents = ${REWARD_CENTS}
    WHERE id = ${row.referral_id} AND referred_rewarded_at IS NULL
    RETURNING id
  `;
  if (claim.rows.length === 0) return { granted: 0 }; // lost the race
  let ledgerId = null;
  try {
    const led = await sql`
      INSERT INTO referral_reward_ledger (workspace_id, user_id, referral_id, side, weeks)
      VALUES (${ws.id}, ${referredUserId}, ${row.referral_id}, 'referred', 1)
      ON CONFLICT (referral_id, side) DO UPDATE SET weeks = referral_reward_ledger.weeks
      RETURNING id
    `;
    ledgerId = led.rows[0]?.id || null;
    if (platform === 'stripe') {
      await applyStripeWeek({ ws, ledgerId, description: 'Ivy referral welcome gift - one free week' });
    }
  } catch (err) {
    await rollbackClaim({ referralId: row.referral_id, ledgerId, side: 'referred' });
    console.error('[referrals] referred credit apply failed:', err.message);
    return { granted: 0 };
  }

  let delivery = 'stripe';
  if (platform === 'apple') {
    const swept = await applyBankedAppleWeeks(ws.id);
    delivery = swept.appliedWeeks > 0 ? 'apple' : 'banked';
  }
  // Best-effort welcome-gift notification.
  notifyReferralReward({ workspaceId: ws.id, variant: 'referred', weeks: 1, delivery })
    .catch((e) => console.warn('[referrals] referred notify failed:', e.message));
  return { granted: 1, platform };
}

// ── Apple delivery ─────────────────────────────────────────────────
// Apple allows at most two renewal extensions per subscription in any
// 365-day window, and at most 90 days per extension. So Apple weeks are
// BANKED on the ledger and delivered in batches: whenever the window has
// room, every banked week goes out in one extension (whole weeks only,
// capped at 90 days; anything over the cap stays banked for next time).
export const APPLE_EXTENSIONS_PER_YEAR = 2;
const APPLE_WINDOW_DAYS = 365;
const CLAIM_STALE_MINUTES = 10;

// How many extensions this subscription has used in the rolling window,
// and when the oldest one drops out (= when the next slot opens).
async function appleWindow(originalTransactionId) {
  const r = await sql`
    SELECT created_at FROM apple_renewal_extensions
     WHERE original_transaction_id = ${originalTransactionId}
       AND created_at > NOW() - make_interval(days => ${APPLE_WINDOW_DAYS})
     ORDER BY created_at ASC
  `;
  const used = r.rows.length;
  const oldest = r.rows[0]?.created_at ? new Date(r.rows[0].created_at) : null;
  const nextEligibleAt = used >= APPLE_EXTENSIONS_PER_YEAR && oldest
    ? new Date(oldest.getTime() + APPLE_WINDOW_DAYS * 86400 * 1000)
    : null;
  return { used, remaining: Math.max(0, APPLE_EXTENSIONS_PER_YEAR - used), nextEligibleAt };
}

// Sweep: deliver this Apple workspace's banked weeks if Apple will take
// them. Never throws. Returns
//   { platform, appliedWeeks, bankedWeeks, days?, nextEligibleAt, reason?, error? }
export async function applyBankedAppleWeeks(workspaceId) {
  const out = { platform: null, appliedWeeks: 0, bankedWeeks: 0, nextEligibleAt: null };
  try {
    const ws = await loadWorkspaceById(workspaceId);
    out.platform = billingPlatform(ws);
    if (!ws || out.platform !== 'apple') return { ...out, reason: 'not-apple' };

    const banked = await sql`
      SELECT id, weeks FROM referral_reward_ledger
       WHERE workspace_id = ${ws.id} AND applied_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < NOW() - make_interval(mins => ${CLAIM_STALE_MINUTES}))
       ORDER BY created_at ASC, id ASC
    `;
    const totalBanked = banked.rows.reduce((n, r) => n + (r.weeks || 1), 0);
    out.bankedWeeks = totalBanked;
    if (totalBanked === 0) return out;

    const win = await appleWindow(ws.apple_original_transaction_id);
    out.nextEligibleAt = win.nextEligibleAt;
    if (win.remaining <= 0) return { ...out, reason: 'apple-limit' };

    if (!appleConfigured()) {
      await sql`
        UPDATE referral_reward_ledger SET note = 'apple-not-configured'
         WHERE workspace_id = ${ws.id} AND applied_at IS NULL
      `;
      return { ...out, reason: 'apple-not-configured' };
    }

    // Whole weeks only, at most 90 days: 14 banked weeks = 98 days, so 12
    // go out now (84 days) and 2 stay banked.
    const maxWeeks = Math.floor(MAX_DAYS_PER_EXTENSION / 7);
    const chosen = [];
    let weeks = 0;
    for (const r of banked.rows) {
      const w = r.weeks || 1;
      if (weeks + w > maxWeeks) break;
      chosen.push(r.id);
      weeks += w;
    }
    if (weeks === 0) return { ...out, reason: 'nothing-fits' };

    // Claim the rows so a concurrent sweep (conversion + renewal landing
    // together) cannot extend twice for the same weeks.
    const requestId = crypto.randomUUID();
    const claimed = await sql`
      UPDATE referral_reward_ledger
         SET claimed_at = NOW(), apple_request_id = ${requestId}
       WHERE id = ANY(${chosen}::uuid[]) AND applied_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < NOW() - make_interval(mins => ${CLAIM_STALE_MINUTES}))
       RETURNING id, weeks
    `;
    const claimedWeeks = claimed.rows.reduce((n, r) => n + (r.weeks || 1), 0);
    if (claimedWeeks === 0) return { ...out, reason: 'claimed-elsewhere' };
    const days = claimedWeeks * 7;

    const result = await extendRenewalDate({
      originalTransactionId: ws.apple_original_transaction_id,
      days,
      reason: REASON_CUSTOMER_SATISFACTION,
      requestId,
    });

    if (!result.ok) {
      await sql`
        UPDATE referral_reward_ledger
           SET claimed_at = NULL, apple_request_id = NULL, note = ${String(result.error || 'apple-failed').slice(0, 500)}
         WHERE apple_request_id = ${requestId} AND applied_at IS NULL
      `;
      console.warn('[referrals] apple extension failed:', result.error);
      return { ...out, reason: 'apple-failed', error: result.error };
    }

    await sql`
      INSERT INTO apple_renewal_extensions (workspace_id, original_transaction_id, days, request_id, effective_date)
      VALUES (${ws.id}, ${ws.apple_original_transaction_id}, ${days}, ${requestId}, ${result.effectiveDate})
    `;
    await sql`
      UPDATE referral_reward_ledger
         SET method = 'apple_extension', applied_at = NOW(), note = NULL,
             apple_effective_date = ${result.effectiveDate}
       WHERE apple_request_id = ${requestId} AND applied_at IS NULL
    `;
    const remaining = totalBanked - claimedWeeks;
    const after = remaining > 0 ? await appleWindow(ws.apple_original_transaction_id) : null;
    return {
      ...out,
      appliedWeeks: claimedWeeks,
      bankedWeeks: remaining,
      days,
      effectiveDate: result.effectiveDate,
      nextEligibleAt: after?.nextEligibleAt || null,
    };
  } catch (err) {
    console.warn('[referrals] applyBankedAppleWeeks failed:', err.message);
    return { ...out, reason: 'error', error: err.message };
  }
}

// Owner-facing delivery summary for GET /api/referrals: how many weeks
// were earned, how many landed, how many are waiting, and when Apple will
// take the next batch.
export async function getRewardSummary(userId) {
  const ws = await loadWorkspaceByOwner(userId);
  const platform = billingPlatform(ws);
  if (!ws) {
    return { platform, earnedWeeks: 0, appliedWeeks: 0, bankedWeeks: 0, nextEligibleAt: null, rewards: [] };
  }
  const { rows } = await sql`
    SELECT l.id, l.side, l.weeks, l.method, l.applied_at, l.apple_effective_date, l.note, l.created_at
      FROM referral_reward_ledger l
     WHERE l.workspace_id = ${ws.id}
     ORDER BY l.created_at DESC
  `;
  const earnedWeeks = rows.reduce((n, r) => n + (r.weeks || 1), 0);
  const appliedWeeks = rows.filter((r) => r.applied_at).reduce((n, r) => n + (r.weeks || 1), 0);
  const bankedWeeks = earnedWeeks - appliedWeeks;
  let nextEligibleAt = null;
  if (platform === 'apple' && bankedWeeks > 0 && ws.apple_original_transaction_id) {
    nextEligibleAt = (await appleWindow(ws.apple_original_transaction_id)).nextEligibleAt;
  }
  return {
    platform,
    earnedWeeks,
    appliedWeeks,
    bankedWeeks,
    nextEligibleAt,
    rewards: rows.map((r) => ({
      id: r.id,
      side: r.side,
      weeks: r.weeks || 1,
      method: r.method,
      appliedAt: r.applied_at,
      effectiveDate: r.apple_effective_date,
      earnedAt: r.created_at,
      pending: !r.applied_at,
    })),
  };
}

// ── Attaching a code after signup ──────────────────────────────────
// iPhone sign-ups cannot carry a ?ref= link, so an owner can enter a
// friend's code afterwards. Allowed only while it cannot be gamed: no
// referral row yet, not a paying owner yet, not their own code, and the
// account is less than 30 days old.
export const ATTACH_WINDOW_DAYS = 30;

export async function canAttachReferralCode(userId) {
  if (!userId) return { ok: false, reason: 'no-user' };
  const r = await sql`
    SELECT u.created_at,
           (SELECT id FROM referrals WHERE referred_user_id = u.id) AS referral_id,
           (SELECT converted_at FROM workspaces WHERE owner_id = u.id LIMIT 1) AS ws_converted_at
      FROM users u WHERE u.id = ${userId}
  `;
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'no-user' };
  if (row.referral_id) return { ok: false, reason: 'already-attached', error: 'A referral is already on your account.' };
  if (row.ws_converted_at) return { ok: false, reason: 'converted', error: 'Referral codes can only be added before your first payment.' };
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (ageMs > ATTACH_WINDOW_DAYS * 86400 * 1000) {
    return { ok: false, reason: 'too-late', error: `Referral codes can be added within ${ATTACH_WINDOW_DAYS} days of signing up.` };
  }
  return { ok: true };
}

export async function attachReferralCode(userId, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'bad-code', error: 'Enter the code your friend shared with you.' };
  const gate = await canAttachReferralCode(userId);
  if (!gate.ok) return gate;
  const referrerUserId = await resolveCodeToReferrer(code);
  if (!referrerUserId) return { ok: false, reason: 'unknown-code', error: 'We could not find that code. Check it and try again.' };
  if (referrerUserId === userId) return { ok: false, reason: 'self-referral', error: 'You cannot use your own code.' };
  const ins = await sql`
    INSERT INTO referrals (referrer_user_id, referred_user_id, code)
    VALUES (${referrerUserId}, ${userId}, ${code})
    ON CONFLICT (referred_user_id) DO NOTHING
    RETURNING id
  `;
  if (ins.rows.length === 0) return { ok: false, reason: 'already-attached', error: 'A referral is already on your account.' };
  return { ok: true, code };
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
