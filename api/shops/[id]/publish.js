// POST /api/shops/:id/publish  { status: 'published' | 'draft' }
// Owner only. Publishing needs an active plan, trial or comp.
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { recordWorkspaceAudit } from '../../_lib/audit.js';
import { loadOwnedShop, setShopStatus, serializeShop, ShopError } from '../../_lib/shops.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const shop = await loadOwnedShop(String(req.query.id || ''), workspaceId);
    if (!shop) return notFound(res, 'Shop page not found');
    const body = await readBody(req);
    const status = body?.status === 'draft' ? 'draft' : body?.status === 'published' ? 'published' : null;
    if (!status) throw new ShopError(400, 'Status must be published or draft');
    const updated = await setShopStatus({ shop, status });
    recordWorkspaceAudit(req, { workspaceId, actor: { id: user.id }, action: status === 'published' ? 'shop.publish' : 'shop.unpublish', target: shop.id, meta: { slug: shop.slug } }).catch(() => {});
    return ok(res, { shop: serializeShop(updated, { owner: true }) });
  } catch (err) {
    if (err instanceof ShopError) return res.status(err.status).json({ error: err.message, code: err.code || undefined });
    return serverError(res, err);
  }
}
