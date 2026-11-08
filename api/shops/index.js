// /api/shops
//   GET  → the signed-in owner's shops: the ones they run, the ones their
//          business is listed on, and invites waiting for them.
//   POST → create a shop page (the owner is its first member).
//
// Owner-only: helpers never reach shop management (ensureActiveWorkspace
// without a helper option refuses the helper header).
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { enforce } from '../_lib/rate-limit.js';
import { recordWorkspaceAudit } from '../_lib/audit.js';
import {
  shopsForWorkspace, createShop, serializeShop, ShopError, SHOP_AMENITIES, SHOP_THEMES, SHARED_ON_SHOP, NEVER_ON_SHOP, SHOP_PLAN_NOTE,
} from '../_lib/shops.js';
import { created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      const data = await shopsForWorkspace(workspaceId, user.email);
      return ok(res, {
        ...data,
        amenities: SHOP_AMENITIES,
        themes: SHOP_THEMES,
        shared: SHARED_ON_SHOP,
        neverShared: NEVER_ON_SHOP,
        planNote: SHOP_PLAN_NOTE,
      });
    }

    if (await enforce(req, res, [{ key: `shops-create:${workspaceId}`, max: 20, windowSeconds: 60 * 60 }])) return;
    const body = await readBody(req);
    const shop = await createShop({ workspaceId, body });
    recordWorkspaceAudit(req, { workspaceId, actor: { id: user.id }, action: 'shop.create', target: shop.id, meta: { slug: shop.slug } }).catch(() => {});
    return created(res, { shop: serializeShop(shop, { owner: true }) });
  } catch (err) {
    if (err instanceof ShopError) return res.status(err.status).json({ error: err.message, code: err.code || undefined });
    return serverError(res, err);
  }
}
