// GET /api/me/usage
//
// Returns the current workspace's daily quota counters so the owner can
// see how close they are to the per-day email / SMS caps before sends
// start failing silently. Wired into the /account Usage card (see
// src/features/account/AccountPage.jsx). Daily counts roll over at
// midnight UTC; that's what tryConsumeQuota / getTodayCount key on.
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';
import {
  getTodayCount,
  DEFAULT_EMAIL_CAP_PER_DAY,
  DEFAULT_SMS_CAP_PER_DAY,
} from '../_lib/usageCounters.js';
import { getDailyUsage as getIvyUsage } from '../_lib/ivy.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    // Two transactional buckets + the AI assistant. All three are
    // workspace-scoped; values are best-effort (a transient DB blip
    // returns 0 rather than 500 — the UI degrades to "—").
    const [email, sms, ivy] = await Promise.all([
      getTodayCount(workspaceId, 'email').catch(() => 0),
      getTodayCount(workspaceId, 'sms').catch(() => 0),
      getIvyUsage(workspaceId).catch(() => null),
    ]);

    return ok(res, {
      email: { used: email, cap: DEFAULT_EMAIL_CAP_PER_DAY },
      sms:   { used: sms,   cap: DEFAULT_SMS_CAP_PER_DAY },
      // getDailyUsage already returns { requests, outputTokens,
      // requestCap, outputTokenCap }. Mirror its shape; null falls
      // through to zeros for a clean UI degrade.
      ivy: ivy || { requests: 0, outputTokens: 0, requestCap: 0, outputTokenCap: 0 },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
