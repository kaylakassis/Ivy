// ensureActiveWorkspace(user, req, res)
//
// The hard-paywall enforcement chokepoint. Drops into the slot where
// owner endpoints used to call ensureWorkspace — every gated route
// looks like:
//
//   const workspaceId = await ensureActiveWorkspace(user, req, res);
//   if (!workspaceId) return;            // 402 already written
//
// Semantics:
//   • Returns the workspace id when the workspace is allowed to use the
//     business app (see isWorkspaceActive — trialing-live, active-live,
//     past_due-in-grace).
//   • Returns null after writing a 402 'subscription-required' otherwise.
//     This includes expired-trial, suspended, cancelled, incomplete,
//     inactive, and anything else we can't positively classify.
//   • FAILS CLOSED on DB error — denies with a distinct
//     'gate-unavailable' status so the frontend can render a retry UI
//     instead of the paywall. This is the inversion from the old
//     subscriptionGate's "log + allow" path: under a hard paywall, a
//     DB blip on the gate read must not silently open the doors.
//   • Sponsored users (user.user_type === 'sponsored') bypass — same
//     comp-account behavior as userContext().
//
// Latency note: a ~60-second per-lambda positive cache means a paying
// owner whose first request hit a healthy DB doesn't get bounced if a
// subsequent request races a brief Neon hiccup. The cache stores only
// "this id was active at time T" — a deactivation (webhook flipping the
// row) still wins within the cache TTL because writes still go through
// fresh checks for new workspaceIds and the TTL is short. We never
// cache the negative answer, so re-checking right after a successful
// checkout doesn't get stuck on a stale "blocked".
import { ensureWorkspace } from './auth.js';
import { isWorkspaceActive } from './clientPortal.js';
import { sql } from './db.js';
import { stampRequestId } from './monitoring.js';

const POSITIVE_CACHE_TTL_MS = 60_000;
// workspaceId -> epoch ms when the cached "active" expires.
const positiveCache = new Map();

function cacheHit(workspaceId) {
  const expiresAt = positiveCache.get(workspaceId);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    positiveCache.delete(workspaceId);
    return false;
  }
  return true;
}

function cacheStore(workspaceId) {
  positiveCache.set(workspaceId, Date.now() + POSITIVE_CACHE_TTL_MS);
  // Bound the map. Under typical load there are very few workspaces in
  // flight per lambda, but defend against a runaway grow path.
  if (positiveCache.size > 2000) {
    const cutoff = Date.now();
    for (const [id, exp] of positiveCache) {
      if (exp <= cutoff) positiveCache.delete(id);
    }
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

export async function ensureActiveWorkspace(user, req, res) {
  // Caller should have already established the user via requireUser;
  // guard anyway because a forgotten guard upstream would otherwise
  // crash here rather than 402 cleanly.
  if (!user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  // Sponsored accounts skip the gate — they're comp'd by the platform
  // and we never want a billing read to lock them out.
  if (user.user_type === 'sponsored') {
    return ensureWorkspace(user.id);
  }

  // ensureWorkspace itself is required for shape (we need the id even
  // on a freshly-created row). If THAT throws, the request can't make
  // any progress anyway, so we surface a 500 by re-throwing — this is
  // not a paywall denial.
  const workspaceId = await ensureWorkspace(user.id);

  if (cacheHit(workspaceId)) return workspaceId;

  let row;
  try {
    const { rows } = await sql`
      SELECT subscription_status, trial_ends_at, subscription_period_end
        FROM workspaces
       WHERE id = ${workspaceId}
       LIMIT 1
    `;
    row = rows[0];
  } catch (err) {
    // FAIL CLOSED. The distinct 'gate-unavailable' status lets the
    // frontend show a retry UI rather than the paywall — paying
    // owners don't see the wrong CTA, but we also don't accidentally
    // grant access during an outage.
    // eslint-disable-next-line no-console
    console.error('[workspaceGate] read failed; denying (fail-closed):', err.message);
    return deny(res, {
      error: 'gate-unavailable',
      message: 'We could not verify your subscription right now. Please retry in a moment.',
    });
  }

  if (!row) {
    // Should not happen — ensureWorkspace just confirmed it exists —
    // but if a concurrent delete won, deny rather than guess.
    return deny(res, {
      error: 'subscription-required',
      status: 'inactive',
      message: 'Your workspace is no longer active.',
    });
  }

  if (isWorkspaceActive(row)) {
    cacheStore(workspaceId);
    return workspaceId;
  }

  // Funnel instrumentation: stamp the very first time this workspace
  // hits the wall. Fire-and-forget — a write failure here mustn't
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
