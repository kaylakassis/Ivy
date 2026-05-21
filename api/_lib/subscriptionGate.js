// requireActiveSubscription(workspaceId, req, res)
//
// Per-handler guard for non-billing write endpoints. Returns true if
// the workspace's subscription is in a state that allows writes;
// returns false (and writes a 402 Payment Required to res) otherwise.
//
// Allowed states for writes: trialing, active, past_due (we extend
// the grace), incomplete (still inside Stripe's first-attempt
// window).
//
// Blocked: suspended (set by api/cron/subscription-dunning after
// GRACE_DAYS past_due) and cancelled.
//
// Reads are NEVER blocked here — the owner needs to see what's in
// the account to decide whether to pay. Only POST/PATCH/DELETE
// flows opt in.
import { sql } from './db.js';

const WRITE_ALLOWED = new Set(['trialing', 'active', 'past_due', 'incomplete']);

export async function requireActiveSubscription(workspaceId, req, res) {
  if (!workspaceId) {
    // Defensive: don't gate a request we can't identify a workspace
    // for. Should never happen if the caller already ran
    // ensureWorkspace, but skip safely rather than 402.
    return true;
  }
  try {
    const { rows } = await sql`
      SELECT subscription_status, trial_ends_at FROM workspaces WHERE id = ${workspaceId}
    `;
    const status = rows[0]?.subscription_status;
    if (!status) return true;

    // Trial is only valid until it expires. The status column stays
    // 'trialing' forever (no cron flips it), so we MUST check the clock
    // here — otherwise a workspace that never paid keeps write access
    // indefinitely. An expired trial is treated like 'cancelled'.
    const trialExpired = status === 'trialing'
      && rows[0].trial_ends_at
      && new Date(rows[0].trial_ends_at).getTime() <= Date.now();

    if (!trialExpired && WRITE_ALLOWED.has(status)) return true;

    // Suspended, cancelled, or an expired trial. Surface a clear payload
    // so the UI can render a "your subscription needs attention" banner +
    // route to /account/billing.
    res.status(402).json({
      error: 'subscription-required',
      status: trialExpired ? 'trial-expired' : status,
      message: status === 'suspended'
        ? 'Your subscription is suspended. Update your payment method to restore access.'
        : trialExpired
          ? 'Your free trial has ended. Subscribe to keep creating.'
          : 'Your subscription is no longer active.',
    });
    return false;
  } catch (err) {
    // Gate-table outage: don't block real users because we can't
    // read their subscription status. Log + allow.
    // eslint-disable-next-line no-console
    console.error('[subscriptionGate] read failed; allowing:', err.message);
    return true;
  }
}
