// GET  /api/account/become-client   → { eligible, reason?, message? }
// POST /api/account/become-client   { confirm: true }
//
// "I'm a client, not a business." For someone who created a business
// account by mistake (or was turned into one before the client-account
// guard existed, see api/_lib/accountKind.js): removes the unused business
// and makes this a client account, so the app opens the client portal.
//
// Only for a business that never had a plan, a trial or free access and
// holds no clients, bookings or other records. Anything else is refused
// with a plain reason; a super-admin can do it from Admin after looking.
import { requireUser, invalidateUserCache, refuseImpersonated } from '../_lib/auth.js';
import { invalidateOwnerWorkspace } from '../_lib/clientPortal.js';
import { clientSwitchCheck, convertToClientAccount } from '../_lib/accountKind.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { recordAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      const check = await clientSwitchCheck(user.id);
      return ok(res, check.ok ? { eligible: true } : { eligible: false, reason: check.reason, message: check.message });
    }

    if (refuseImpersonated(req, res)) return;
    const blocked = await enforce(req, res, [
      { key: `become-client:user:${user.id}`, max: 5, windowSeconds: 60 * 60 },
      { key: `become-client:ip:${getClientIp(req)}`, max: 20, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;
    const body = await readBody(req);
    if (body?.confirm !== true) return badRequest(res, 'Confirm that you want to switch to a client account.');

    const result = await convertToClientAccount(user.id);
    if (!result.ok) return badRequest(res, result.message, { code: `switch-${result.reason}` });

    invalidateOwnerWorkspace(user.id);
    invalidateUserCache(user.id);
    await recordAudit(req, {
      actor: { id: user.id, email: user.email }, targetUserId: user.id,
      action: 'user.became_client_account', meta: { workspaceId: result.workspaceId, by: 'self' },
    }).catch(() => { /* the switch is done; the log line is best-effort */ });
    return ok(res, { ok: true, landing: 'client' });
  } catch (err) {
    return serverError(res, err);
  }
}
