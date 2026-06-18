// /api/referrals
//   GET  → the signed-in owner's referral code (if set) + program stats.
//   PUT  → set / change the owner's referral code.  body: { code }
//
// Self-serve "refer one, get one": every paying owner can share their
// code; each referred user who becomes paying earns the referrer one
// free month (credited to their Stripe customer balance). See
// api/_lib/referrals.js for the reward mechanics.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { appUrl } from '../_lib/tokens.js';
import { getCode, setCode, getReferralStats, REWARD_CENTS } from '../_lib/referrals.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    // Ensure the user is an owner (has a workspace) AND the workspace
    // has an active subscription - referral is an owner-facing program
    // under the hard paywall.
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      const [code, stats] = await Promise.all([
        getCode(user.id),
        getReferralStats(user.id),
      ]);
      return ok(res, {
        code,
        link: code ? `${appUrl()}/signup?ref=${encodeURIComponent(code)}` : null,
        rewardCents: REWARD_CENTS,
        stats,
      });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readBody(req);
      const result = await setCode(user.id, body.code);
      if (!result.ok) return badRequest(res, result.error);
      const stats = await getReferralStats(user.id);
      return ok(res, {
        code: result.code,
        link: `${appUrl()}/signup?ref=${encodeURIComponent(result.code)}`,
        rewardCents: REWARD_CENTS,
        stats,
      });
    }

    return methodNotAllowed(res, ['GET', 'PUT', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
