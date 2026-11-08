// GET /api/shops/slug-check?slug=…&shopId=…  → { slug, valid, available }
// Live availability check while the owner types a shop web address.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { validShopSlug, slugTaken, isUuid } from '../_lib/shops.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, [{ key: `shop-slug-check:${workspaceId}`, max: 240, windowSeconds: 600 }])) return;
    const slug = String(req.query.slug || '').toLowerCase().trim().slice(0, 60);
    const shopId = isUuid(String(req.query.shopId || '')) ? String(req.query.shopId) : null;
    const valid = validShopSlug(slug);
    const available = valid ? !(await slugTaken(slug, shopId)) : false;
    return ok(res, { slug, valid, available });
  } catch (err) {
    return serverError(res, err);
  }
}
