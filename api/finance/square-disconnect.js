// POST /api/finance/square-disconnect
// Owner-only. Wipes the workspace's stored Square credentials. We do
// NOT call Square's revoke endpoint - owners can re-connect any time
// and revoking would force them through merchant onboarding again.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { disconnect } from '../_lib/payments/square.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    await disconnect({ workspaceId });
    return ok(res, { disconnected: true });
  } catch (err) {
    return serverError(res, err);
  }
}
