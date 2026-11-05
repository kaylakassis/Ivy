// POST /api/billing/start-trial
// Used to start a no-card 14-day trial. Trials now require a card (they start
// through checkout), so this only reports an existing plan or trial and
// otherwise answers 400 card_required. Kept so older app builds get a clear
// message instead of a 404.
//
// Returns the new subscription block in the same shape /api/me uses, so
// the Paywall can swap into "trial active" view without re-fetching.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { invalidateOwnerWorkspace } from '../_lib/clientPortal.js';
import { requireSameOrigin } from '../_lib/security.js';
import { hasUsedTrial } from '../_lib/billingGuard.js';
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
    // repeatedly and keep using Ivy without ever paying.
    // ...and one trial per person: an earlier account with this email that
    // already had a trial (or a paid plan) counts, even if it was deleted.
    if (r.trial_ends_at || await hasUsedTrial(user.email)) {
      return ok(res, {
        ok: true,
        alreadyTrialed: true,
        status: r.subscription_status,
        trialEndsAt: r.trial_ends_at,
        periodEndsAt: r.subscription_period_end,
      });
    }

    // Card required: the free trial only starts through checkout with a card
    // on file (Stripe on the web, the Apple offer in the app). This endpoint
    // no longer grants a trial; older app builds that still call it get a
    // clear message pointing to the plans screen.
    return res.status(400).json({
      error: 'Your free trial starts with a card on file. Choose a plan to start it.',
      code: 'card_required',
    });
  } catch (err) {
    return serverError(res, err);
  }
}
