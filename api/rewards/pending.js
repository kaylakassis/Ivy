// /api/rewards/pending — GET list of clients who've earned a reward but
// haven't been issued one yet for the matching rule. Drives the "Ready to
// redeem" panel on the rewards tab.
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { pendingRewards } from '../_lib/rewards.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const pending = await pendingRewards(workspaceId);
    return ok(res, { pending });
  } catch (err) {
    return serverError(res, err);
  }
}
