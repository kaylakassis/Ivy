// /api/shops/:id/join-link  (shop owner only)
//   POST   → mint a new share link (any Ivy business owner on a plan can
//            use it to join; the old link stops working). 14 days.
//   DELETE → turn the share link off.
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { enforce } from '../../_lib/rate-limit.js';
import { loadOwnedShop, regenerateJoinLink, clearJoinLink, ShopError } from '../../_lib/shops.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!['POST', 'DELETE'].includes(req.method)) return methodNotAllowed(res, ['POST', 'DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const shop = await loadOwnedShop(String(req.query.id || ''), workspaceId);
    if (!shop) return notFound(res, 'Shop page not found');
    if (req.method === 'DELETE') {
      await clearJoinLink({ shop });
      return ok(res, { cleared: true });
    }
    if (await enforce(req, res, [{ key: `shop-joinlink:${shop.id}`, max: 20, windowSeconds: 3600 }])) return;
    const out = await regenerateJoinLink({ shop });
    return ok(res, out);
  } catch (err) {
    if (err instanceof ShopError) return res.status(err.status).json({ error: err.message, code: err.code || undefined });
    return serverError(res, err);
  }
}
