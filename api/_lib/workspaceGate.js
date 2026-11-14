// ensureActiveWorkspace(user, req, res)
//
// The hard-paywall enforcement chokepoint. Drops into the slot where
// owner endpoints used to call ensureWorkspace - every gated route
// looks like:
//
//   const workspaceId = await ensureActiveWorkspace(user, req, res);
//   if (!workspaceId) return;            // 402 already written
//
// Semantics:
//   • Returns the workspace id when the workspace is allowed to use the
//     business app (see isWorkspaceActive - trialing-live, active-live,
//     past_due-in-grace).
//   • Returns null after writing a 402 'subscription-required' otherwise.
//     This includes expired-trial, suspended, cancelled, incomplete,
//     inactive, and anything else we can't positively classify.
//   • FAILS CLOSED on DB error - denies with a distinct
//     'gate-unavailable' status so the frontend can render a retry UI
//     instead of the paywall. This is the inversion from the old
//     subscriptionGate's "log + allow" path: under a hard paywall, a
//     DB blip on the gate read must not silently open the doors.
//   • Sponsored users (user.user_type === 'sponsored') bypass - same
//     comp-account behavior as userContext().
//
// Latency note: a ~60-second per-lambda positive cache means a paying
// owner whose first request hit a healthy DB doesn't get bounced if a
// subsequent request races a brief Neon hiccup. The cache stores only
// "this id was active at time T" - a deactivation (webhook flipping the
// row) still wins within the cache TTL because writes still go through
// fresh checks for new workspaceIds and the TTL is short. We never
// cache the negative answer, so re-checking right after a successful
// checkout doesn't get stuck on a stale "blocked".
import { ensureWorkspace } from './auth.js';
import { isWorkspaceActive } from './clientPortal.js';
import { isHelperUser, helperWorkspaceFromRequest, resolveHelperAccess } from './helpers.js';
import { sql } from './db.js';
import { stampRequestId } from './monitoring.js';

const POSITIVE_CACHE_TTL_MS = 60_000;
// workspaceId -> epoch ms when the cached "active" expires.
//
// Sized for ~100K active workspaces. JS Map preserves insertion order,
// so an LRU eviction is a one-line `keys().next()` + delete on overflow.
// Each entry is ~50 bytes (UUID + number), so 50K caps memory at ~2.5 MB
// per lambda — comfortably under serverless limits, and the hit rate
// climbs from ~2% (old 2K cap) to >95% under steady-state traffic.
const POSITIVE_CACHE_MAX = 50_000;
const positiveCache = new Map();

function cacheHit(workspaceId) {
  const expiresAt = positiveCache.get(workspaceId);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    positiveCache.delete(workspaceId);
    return false;
  }
  // Touch: re-insert so this workspaceId moves to the tail (most-recent).
  // Map preserves insertion order; deleting + setting again is the
  // idiomatic LRU touch in JS.
  positiveCache.delete(workspaceId);
  positiveCache.set(workspaceId, expiresAt);
  return true;
}

function cacheStore(workspaceId) {
  // If already present, delete first so the re-insert moves it to the tail.
  if (positiveCache.has(workspaceId)) positiveCache.delete(workspaceId);
  positiveCache.set(workspaceId, Date.now() + POSITIVE_CACHE_TTL_MS);
  // LRU eviction when full. Map.keys().next() returns the oldest key in
  // O(1); we just drop it. Beats the old "sweep all expired" path which
  // amortized poorly under high churn.
  if (positiveCache.size > POSITIVE_CACHE_MAX) {
    const oldest = positiveCache.keys().next().value;
    if (oldest !== undefined) positiveCache.delete(oldest);
  }
}

// Expose for tests + for /api/billing/sync to evict immediately after a
// successful subscribe (so the next request sees the fresh state, not
// a stale "blocked" or pre-purchase result).
export function evictWorkspaceGateCache(workspaceId) {
  if (workspaceId) positiveCache.delete(workspaceId);
}

function deny(res, payload) {
  stampRequestId(undefined, res);
  res.status(402).json(payload);
  return null;
}

// `opts.helper` lets an owner endpoint accept HELPERS (api/_lib/helpers.js)
// acting on a business they help at, picked by the X-Helper-Workspace
// header: a permission key ('schedule' | 'clients' | 'messages'), an
// array (any of), or true (any active helper). Routes that pass nothing
// stay owner-only and answer a helper with 403 helper-only. In helper
// mode `req.helper` carries the membership so the handler can narrow
// itself (never charge a fee, attribute a message, scope threads).
export async function ensureActiveWorkspace(user, req, res, opts = {}) {
  // Caller should have already established the user via requireUser;
  // guard anyway because a forgotten guard upstream would otherwise
  // crash here rather than 402 cleanly.
  if (!user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  if (helperWorkspaceFromRequest(req)) {
    return resolveHelperAccess(user, req, res, {
      permission: opts.helper === true ? undefined : opts.helper,
      allowed: opts.helper !== undefined && opts.helper !== null && opts.helper !== false,
    });
  }
  // Helper-only accounts (someone's assistant, api/_lib/helpers.js) own
  // nothing and must never get a workspace minted for them by hitting an
  // owner endpoint. Refuse with a plain 403 before ensureWorkspace's
  // auto-create runs. Owners who also help elsewhere are unaffected:
  // they already have a workspace row, so this branch is skipped.
  const owned = await sql`SELECT id FROM workspaces WHERE owner_id = ${user.id} ORDER BY created_at ASC, id ASC LIMIT 1`;
  if (owned.rows.length === 0 && await isHelperUser(user.id)) {
    stampRequestId(undefined, res);
    res.status(403).json({
      error: 'helper-only',
      message: 'Helper accounts can only see their own schedule.',
    });
    return null;
  }

  // ensureWorkspace itself is required for shape (we need the id even
  // on a freshly-created row). If THAT throws, the request can't make
  // any progress anyway, so we surface a 500 by re-throwing - this is
  // not a paywall denial. The row we just read saves the re-SELECT for
  // every existing owner.
  const workspaceId = owned.rows[0]?.id || await ensureWorkspace(user.id);
  // Sponsored AND beta accounts are comp'd by the platform (sponsored =
  // permanent comp, beta = beta-program access): they skip the billing
  // check below, and a failed read never locks them out. A risk hold
  // still applies to them.
  const platformComped = user.user_type === 'sponsored' || user.user_type === 'beta';

  if (cacheHit(workspaceId)) return workspaceId;

  let row;
  try {
    const { rows } = await sql`
      SELECT subscription_status, trial_ends_at, subscription_period_end, comp_until, onboarded_at,
             risk_hold_at
        FROM workspaces
       WHERE id = ${workspaceId}
       LIMIT 1
    `;
    row = rows[0];
  } catch (err) {
    // FAIL CLOSED. The distinct 'gate-unavailable' status lets the
    // frontend show a retry UI rather than the paywall - paying
    // owners don't see the wrong CTA, but we also don't accidentally
    // grant access during an outage.
    if (platformComped) return workspaceId;
    // eslint-disable-next-line no-console
    console.error('[workspaceGate] read failed; denying (fail-closed):', err.message);
    return deny(res, {
      error: 'gate-unavailable',
      message: 'We could not verify your subscription right now. Please retry in a moment.',
    });
  }

  if (!row) {
    // Should not happen - ensureWorkspace just confirmed it exists -
    // but if a concurrent delete won, deny rather than guess.
    return deny(res, {
      error: 'subscription-required',
      status: 'inactive',
      message: 'Your workspace is no longer active.',
    });
  }

  // Risk hold (api/_lib/riskHold.js): checked before every other pass,
  // including platform-comped accounts and a business still onboarding.
  // 402 like the paywall so older app builds stop cleanly; newer ones
  // read the code and show "on hold, contact us".
  if (row.risk_hold_at) {
    return deny(res, {
      error: 'account-on-hold',
      code: 'account_on_hold',
      status: 'on_hold',
      message: 'This account is on hold while we review it. Email hello@joinivy.ai and we will sort it out.',
    });
  }

  if (platformComped) {
    cacheStore(workspaceId);
    return workspaceId;
  }

  // Onboarding bypass. The funnel design is: signup → onboarding →
  // (onboarding_complete sets onboarded_at) → THEN the hard paywall
  // fires. So while onboarded_at IS NULL, every gated endpoint is open
  // for the user to actually finish setting up - configure business
  // info, services, branding, etc. Without this bypass, the onboarding
  // wizard's first calendar PATCH 402s and the new owner can't proceed.
  // We cache this just like a positive subscription so we don't hammer
  // the DB on every request during the onboarding session.
  if (row.onboarded_at == null) {
    cacheStore(workspaceId);
    return workspaceId;
  }

  if (isWorkspaceActive(row)) {
    cacheStore(workspaceId);
    return workspaceId;
  }

  // Funnel instrumentation: stamp the very first time this workspace
  // hits the wall. Fire-and-forget - a write failure here mustn't
  // block the 402 response. COALESCE keeps the original timestamp on
  // every subsequent denial so we measure FIRST-seen, not last-seen.
  sql`UPDATE workspaces
        SET paywall_first_seen_at = COALESCE(paywall_first_seen_at, NOW())
      WHERE id = ${workspaceId} AND paywall_first_seen_at IS NULL`
    .catch((e) => console.error('[workspaceGate] paywall stamp failed:', e.message));

  // Surface a structured payload the UI uses to pick the right CTA.
  const status = row.subscription_status || 'inactive';
  const trialExpired = status === 'trialing'
    && row.trial_ends_at
    && new Date(row.trial_ends_at).getTime() <= Date.now();

  return deny(res, {
    error: 'subscription-required',
    status: trialExpired ? 'trial-expired' : status,
    message:
        status === 'suspended'  ? 'Your subscription is suspended. Update your payment method to restore access.'
      : trialExpired            ? 'Your free trial has ended. Subscribe to keep creating.'
      : status === 'cancelled'  ? 'Your subscription was cancelled. Reactivate to keep creating.'
      : status === 'incomplete' ? 'Your subscription needs a successful payment to activate.'
      :                            'Your subscription is no longer active.',
  });
}
