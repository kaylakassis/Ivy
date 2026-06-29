// Helpers for the /api/me client-portal endpoints.
//
// A user can be:
//   • An OWNER of a workspace (workspaces.owner_id = user.id)
//   • A CLIENT of one or more businesses (clients.user_id = user.id, OR
//     clients.email matches the user's email - the latter handles "claim
//     your account" before user_id is wired up)
//   • Both, if they own a business AND book with another business
//
// All client-portal queries are scoped to the joined set of `clients` rows
// owned by this user. We never trust user-supplied workspaceId / clientId
// - every read is filtered through `myClientIds()` so a malicious request
// can't peek at someone else's data.
import { sql } from './db.js';
import { getOrSet, invalidate as cacheInvalidate } from './hotCache.js';

// Returns the IDs of every `clients` row this user owns, across workspaces.
// Matches by user_id first, then auto-claims any rows with the same email
// (so links pre-dating signup get attached to the user).
//
// SECURITY: the email auto-claim only runs once the user's email is verified.
// Without this guard, anyone could sign up with a known target's email
// address and immediately scoop up every workspace's clients-row that
// happens to use that email - a cross-tenant data exfiltration path. The
// verification step proves the user actually controls the inbox before we
// link any pre-existing records to their account.
//
// Tolerates a partial schema. If `clients`/`calendar_settings` haven't been
// created yet on a cold install we return an empty memberships list rather
// than letting the error 500 the whole /api/me response (which would leave
// new signups stuck on a crashed router with no way to reach the dashboard).
export async function myClientIds(user) {
  try {
    if (user.email && user.email_verified_at) {
      await sql`
        UPDATE clients
        SET user_id = ${user.id}
        WHERE LOWER(email) = ${user.email.toLowerCase()}
          AND (user_id IS NULL OR user_id <> ${user.id})
      `;
    }

    const { rows } = await sql`
      SELECT c.id, c.workspace_id, c.name, c.email,
             w.name AS workspace_name,
             cs.biz_name
      FROM clients c
      JOIN workspaces w ON w.id = c.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = c.workspace_id
      WHERE c.user_id = ${user.id}
      ORDER BY COALESCE(cs.biz_name, w.name) ASC
    `;
    return rows.map((r) => ({
      clientId:     r.id,
      workspaceId:  r.workspace_id,
      clientName:   r.name,
      clientEmail:  r.email,
      businessName: r.biz_name || r.workspace_name || 'Business',
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[clientPortal] myClientIds failed (returning empty):', err.message);
    return [];
  }
}

// Convenience: just the IDs for SQL `WHERE c.id IN (...)` checks.
export function ids(memberships) {
  return memberships.map((m) => m.clientId);
}

// Does this user own a workspace? Returns { id, onboardedAt, subscription,
// bizName, slug } or null. The biz_name + slug come from calendar_settings
// so the sidebar workspace badge can show "Maple Massage" instead of
// "Untitled" once the owner finishes onboarding.
//
// Tolerates partial schema: if calendar_settings or one of the subscription
// columns hasn't been added yet (cold install / partial migration), we fall
// back to a minimal lookup so /api/me still returns a usable context. The
// user can then onboard normally - the alternative is a 500 that leaves
// them stuck on the sign-in screen with no recovery.
// Cache TTL for ownsWorkspace. Short enough that a Stripe checkout
// completion / subscription state change becomes visible within ~30s
// even if the explicit invalidate() call misfires; long enough to
// absorb a navigation burst (5-10 /api/me hits in the first second of
// a page load) on warm function instances. The write paths that
// matter — billing webhook, sync endpoint, RevenueCat webhook,
// onboarding/complete, calendar PATCH — call invalidateOwnerWorkspace
// after they commit so the change is visible immediately, not after
// the TTL.
const OWNS_WORKSPACE_TTL_MS = 30_000;

export async function ownsWorkspace(userId) {
  if (!userId) return null;
  return getOrSet(`owns:${userId}`, OWNS_WORKSPACE_TTL_MS, () => ownsWorkspaceFromDb(userId));
}

// Invalidate the cached ownsWorkspace blob for the given userId. Cheap
// (Map.delete). Call after any write that changes a field returned by
// the SELECT above — subscription_status, trial_ends_at,
// subscription_period_end, stripe_customer_id, onboarded_at, biz_name,
// slug, business_type — so the next /api/me read picks up the change
// without waiting for the TTL.
export function invalidateOwnerWorkspace(userId) {
  if (userId) cacheInvalidate(`owns:${userId}`);
}

// Convenience overload for write paths that only know the workspaceId
// (Stripe webhook, RevenueCat webhook). One extra indexed lookup
// (owner_id is the unique key) then invalidates. Returns the userId so
// the caller can use it for related cache busts.
export async function invalidateOwnerWorkspaceByWorkspaceId(workspaceId) {
  if (!workspaceId) return null;
  try {
    const { rows } = await sql`SELECT owner_id FROM workspaces WHERE id = ${workspaceId} LIMIT 1`;
    const ownerId = rows[0]?.owner_id;
    if (ownerId) invalidateOwnerWorkspace(ownerId);
    return ownerId || null;
  } catch (err) {
    // Cache invalidation is best-effort — a missed bust just means a
    // ≤30s lag for the next /api/me read. Log + swallow so a transient
    // DB blip never breaks the webhook handler that called us.
    // eslint-disable-next-line no-console
    console.warn('[clientPortal] invalidateOwnerWorkspaceByWorkspaceId lookup failed:', err.message);
    return null;
  }
}

async function ownsWorkspaceFromDb(userId) {
  try {
    const { rows } = await sql`
      SELECT w.id, w.onboarded_at, w.business_type,
             w.subscription_status, w.trial_ends_at, w.subscription_period_end,
             w.stripe_customer_id,
             cs.biz_name, cs.slug
      FROM workspaces w
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
      WHERE w.owner_id = ${userId} LIMIT 1
    `;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      onboardedAt: r.onboarded_at,
      businessType: r.business_type || 'both',
      bizName: r.biz_name || null,
      slug:    r.slug || null,
      subscription: deriveSubscription(r),
      // True when a Stripe customer exists for this workspace - the
      // Paywall uses this to decide whether the "Manage billing"
      // (Customer Portal) button is meaningful. Without a customer
      // record the portal endpoint 400s.
      hasBillingRecord: !!r.stripe_customer_id,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[clientPortal] ownsWorkspace full query failed; falling back:', err.message);
    try {
      const { rows } = await sql`SELECT id, onboarded_at FROM workspaces WHERE owner_id = ${userId} LIMIT 1`;
      if (!rows.length) return null;
      return {
        id: rows[0].id,
        onboardedAt: rows[0].onboarded_at,
        businessType: 'both',  // safe default - column may be pre-migration
        bizName: null,
        slug: null,
        subscription: { status: 'inactive', isActive: false, inTrial: false, trialEndsAt: null, periodEndsAt: null, daysRemaining: null },
      };
    } catch (err2) {
      // eslint-disable-next-line no-console
      console.error('[clientPortal] ownsWorkspace fallback also failed:', err2.message);
      return null;
    }
  }
}

// The single source of truth for "is this workspace allowed to use the
// business app?" Both the backend gate (workspaceGate.js) and the
// frontend-facing serializer (deriveSubscription, below) call this so
// they can never disagree about whether a row counts as active.
//
// Allowed (hard-paywall semantics):
//   • trialing  - only while trial_ends_at is in the future
//   • active    - only while subscription_period_end is in the future
//   • past_due  - Stripe's smart-retry grace; we stay open and let
//                 webhooks flip to suspended when retries run out.
//
// Blocked: incomplete (checkout flips to active in seconds, and
// blocking surfaces the wall right away if a card fails), suspended,
// cancelled, inactive, and trial- or period-expired forms of the above.
//
// `incomplete` is INTENTIONALLY not on the allowed list - under the
// hard paywall it shows the wall so the owner sees the right CTA, not
// a half-broken app.
export function isWorkspaceActive(row) {
  if (!row) return false;
  const status = row.subscription_status || 'inactive';
  const now = Date.now();
  const trialEndsAt  = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : null;
  const periodEndsAt = row.subscription_period_end ? new Date(row.subscription_period_end).getTime() : null;
  if (status === 'trialing') return !!(trialEndsAt && trialEndsAt > now);
  if (status === 'active')   return !!(periodEndsAt && periodEndsAt > now);
  // past_due grace is owned by api/cron/subscription-dunning.js, which
  // flips the row to 'suspended' GRACE_DAYS (14) after the first failed
  // invoice. While the row is still 'past_due', Stripe is mid-retry and
  // we keep the app open - period_end has typically just lapsed.
  if (status === 'past_due') return true;
  return false;
}

// Turn the raw workspace row into the shape the frontend wants. `isActive`
// is the single source of truth for whether the business app is unlocked
// - derived from status + the trial / period end timestamps so the UI
// doesn't have to redo the comparison.
function deriveSubscription(row) {
  const status = row.subscription_status || 'inactive';
  const now = Date.now();
  const trialEndsAt    = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : null;
  const periodEndsAt   = row.subscription_period_end ? new Date(row.subscription_period_end).getTime() : null;
  const trialActive    = status === 'trialing' && trialEndsAt && trialEndsAt > now;
  const periodLive     = (status === 'active' || status === 'past_due')
                          && periodEndsAt && periodEndsAt > now;
  // isActive MUST come from the shared predicate so the backend gate
  // (workspaceGate.js) and this /api/me serializer can never disagree -
  // e.g. past_due is "active" (grace) here exactly as it is in the gate,
  // even when period_end has lapsed. Computing it independently is what
  // let them drift before.
  const isActive = isWorkspaceActive(row);

  let daysRemaining = null;
  // Countdown only when there's a live end timestamp to count toward.
  // past_due-with-lapsed-period is active but has no countdown (the UI
  // shows a "payment failed" banner instead of days remaining).
  const endRef = trialActive ? trialEndsAt : (periodLive ? periodEndsAt : null);
  if (endRef) {
    daysRemaining = Math.max(0, Math.ceil((endRef - now) / (24 * 60 * 60 * 1000)));
  }
  return {
    status,
    isActive,
    inTrial: trialActive,
    trialEndsAt: row.trial_ends_at,
    periodEndsAt: row.subscription_period_end,
    daysRemaining,
  };
}

// Build a context object the frontend uses to choose the default app +
// render the view-switcher only when the user is genuinely both.
export async function userContext(user) {
  const [workspace, memberships] = await Promise.all([
    ownsWorkspace(user.id),
    myClientIds(user),
  ]);

  // Sponsored and beta accounts are comp'd by the platform - we
  // synthesize an always-active subscription so the Paywall renders
  // nothing for them even if their workspace row's columns drift from
  // the admin endpoint.
  const isCompd = user.user_type === 'sponsored' || user.user_type === 'beta';
  let subscription = workspace?.subscription || null;
  if (isCompd && workspace) {
    subscription = {
      status: 'active',
      isActive: true,
      inTrial: false,
      trialEndsAt: null,
      periodEndsAt: null,
      daysRemaining: null,
      sponsored: user.user_type === 'sponsored',
      beta:      user.user_type === 'beta',
    };
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerifiedAt: user.email_verified_at,
      userType: user.user_type || 'regular',
    },
    isOwner:  !!workspace,
    isClient: memberships.length > 0,
    workspaceId: workspace?.id || null,
    onboardedAt: workspace?.onboardedAt || null,
    bizName: workspace?.bizName || null,
    bookingSlug: workspace?.slug || null,
    subscription,
    // Surfaced to the Paywall so it can hide "Manage billing" when no
    // Stripe customer exists yet.
    hasBillingRecord: !!workspace?.hasBillingRecord,
    walkthroughCompletedAt: user.walkthrough_completed_at || null,
    memberships,
  };
}
