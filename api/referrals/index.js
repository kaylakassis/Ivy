// /api/referrals
//   GET  → the signed-in owner's referral code (if set) + program stats.
//   PUT  → set / change the owner's referral code.  body: { code }
//
// Self-serve "refer a friend, you both get a free week": every paying
// owner can share their code; each referred user who becomes paying earns
// BOTH the referrer and themselves one free week (credited to each one's
// Stripe customer balance). See api/_lib/referrals.js for the mechanics.
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { appUrl } from '../_lib/tokens.js';
import { getCode, setCode, getReferralStats, listReferrals, REWARD_CENTS } from '../_lib/referrals.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    // Referral is open to owners on a TRIAL as well as paid — the trial
    // honeymoon is exactly when owners evangelize, and the reward only pays out
    // once a referred owner subscribes (grantPendingReferralCredits keeps it
    // pending until the referrer has a Stripe customer, so there's no downside
    // to a trial referrer). Only fully-lapsed/never-started owners are excluded.
    const workspaceId = await ensureWorkspace(user.id);
    const isComped = user.user_type === 'sponsored' || user.user_type === 'beta';
    if (!isComped) {
      const { rows } = await sql`SELECT subscription_status FROM workspaces WHERE id = ${workspaceId}`;
      const status = rows[0]?.subscription_status;
      if (!['trialing', 'active', 'past_due'].includes(status)) {
        return badRequest(res, 'Referrals are available once you start your trial or subscribe.');
      }
    }

    if (req.method === 'GET') {
      const [code, stats, referrals] = await Promise.all([
        getCode(user.id),
        getReferralStats(user.id),
        listReferrals(user.id),
      ]);
      return ok(res, {
        code,
        link: code ? `${appUrl()}/signup?ref=${encodeURIComponent(code)}` : null,
        rewardCents: REWARD_CENTS,
        stats,
        referrals,
        weeksEarned: stats.rewarded || 0,
        terms: { bothSides: true, rewardWeeks: 1 },
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
