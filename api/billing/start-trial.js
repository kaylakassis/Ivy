// POST /api/billing/start-trial
// Starts (or re-starts) a 14-day trial for the owner's workspace, but only
// if they're not already in an active state. Idempotent - calling while
// already trialing/active is a no-op.
//
// Returns the new subscription block in the same shape /api/me uses, so
// the Paywall can swap into "trial active" view without re-fetching.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { invalidateOwnerWorkspace } from '../_lib/clientPortal.js';
import { requireSameOrigin } from '../_lib/security.js';
import { TRIAL_DAYS } from '../_lib/billing.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const cur = await sql`
      SELECT subscription_status, trial_ends_at, subscription_period_end
      FROM workspaces WHERE id = ${workspaceId}
    `;
    const r = cur.rows[0];
    if (!r) return badRequest(res, 'No workspace');

    const now = Date.now();
    const stillTrialing = r.subscription_status === 'trialing'
      && r.trial_ends_at && new Date(r.trial_ends_at).getTime() > now;
    const paidActive = (r.subscription_status === 'active' || r.subscription_status === 'past_due')
      && r.subscription_period_end && new Date(r.subscription_period_end).getTime() > now;

    if (stillTrialing || paidActive) {
      return ok(res, {
        ok: true,
        alreadyActive: true,
        status: r.subscription_status,
        trialEndsAt: r.trial_ends_at,
        periodEndsAt: r.subscription_period_end,
      });
    }

    // One trial per workspace. Every workspace is auto-trialed at creation
    // (trial_ends_at column default), and the UI already hides the trial
    // button once it's set (Paywall: everTrialed = !!sub.trialEndsAt). We
    // enforce the SAME rule server-side: a non-null trial_ends_at means
    // this workspace already had its trial, so refuse to re-grant a fresh
    // one. Without this, a lapsed/cancelled owner could POST start-trial
    // repeatedly and keep using Ivy OS without ever paying.
    if (r.trial_ends_at) {
      return ok(res, {
        ok: true,
        alreadyTrialed: true,
        status: r.subscription_status,
        trialEndsAt: r.trial_ends_at,
        periodEndsAt: r.subscription_period_end,
      });
    }

    const { rows } = await sql`
      UPDATE workspaces SET
        subscription_status = 'trialing',
        trial_ends_at       = NOW() + (${TRIAL_DAYS}::int || ' days')::interval
      WHERE id = ${workspaceId}
      RETURNING subscription_status, trial_ends_at, subscription_period_end
    `;
    const after = rows[0];
    invalidateOwnerWorkspace(user.id);
    return ok(res, {
      ok: true,
      alreadyActive: false,
      status: after.subscription_status,
      trialEndsAt: after.trial_ends_at,
      periodEndsAt: after.subscription_period_end,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
