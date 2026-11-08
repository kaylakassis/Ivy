// /api/shops/:id/listing  (a member, about their OWN listing only)
//   PATCH  { title?, bio?, visibleServiceIds? (null = all) }
//   DELETE → leave the shop in one tap; the listing comes off at once.
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { recordWorkspaceAudit } from '../../_lib/audit.js';
import { updateListing, leaveShop, serializeMember, ShopError } from '../../_lib/shops.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!['PATCH', 'DELETE'].includes(req.method)) return methodNotAllowed(res, ['PATCH', 'DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const shopId = String(req.query.id || '');
    if (req.method === 'DELETE') {
      const out = await leaveShop({ shopId, workspaceId });
      recordWorkspaceAudit(req, { workspaceId, actor: { id: user.id }, action: 'shop.leave', target: shopId, meta: {} }).catch(() => {});
      return ok(res, out);
    }
    const body = await readBody(req);
    const row = await updateListing({ shopId, workspaceId, body });
    return ok(res, { me: serializeMember(row) });
  } catch (err) {
    if (err instanceof ShopError) return res.status(err.status).json({ error: err.message, code: err.code || undefined });
    return serverError(res, err);
  }
}
