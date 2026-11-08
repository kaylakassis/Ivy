// GET /api/shop/:slug/data → the whole public shop page in one call:
// the shop, every listed member with its public booking data (settings,
// chosen services, busy blocks, redacted bookings, reviews) and the
// count-weighted rating. Members whose plan lapsed, who left or who were
// removed are not in it. ?preview=1 lets the signed-in owner see their
// own page (a draft included) before it goes public.
import { warmupDbOnce } from '../../_lib/db.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { publicShopPayload, validShopSlug, ownedWorkspaceOf } from '../../_lib/shops.js';
import { requireUser } from '../../_lib/auth.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    await warmupDbOnce();
    await ensureSchemaApplied();
    const slug = String(req.query.slug || '').toLowerCase();
    if (!validShopSlug(slug)) return notFound(res, 'No shop page at that address');
    const ip = getClientIp(req);
    if (await enforce(req, res, [
      { key: `shopget:ip:${ip}`, max: 120, windowSeconds: 600 },
      { key: `shopget:slug:${slug}`, max: 600, windowSeconds: 600 },
    ])) return;
    // ?preview=1: the signed-in owner sees their own page, draft included.
    // Anyone else (or a shop they do not own) gets the public answer.
    let previewWorkspaceId = null;
    if (req.query.preview === '1') {
      const user = await requireUser(req, res);
      if (!user) return;
      previewWorkspaceId = await ownedWorkspaceOf(user.id);
      if (!previewWorkspaceId) return notFound(res, 'No shop page at that address');
    }
    const payload = await publicShopPayload(slug, { previewWorkspaceId });
    if (!payload) return notFound(res, 'No shop page at that address');
    // Never cached: a pro who leaves (or whose plan lapses) must vanish on
    // the next load, and open times must be live. (A browser honours
    // stale-while-revalidate too, so even a short shared cache kept a
    // departed pro on screen for minutes.)
    res.setHeader('Cache-Control', 'no-store');
    return ok(res, payload);
  } catch (err) {
    return serverError(res, err);
  }
}
