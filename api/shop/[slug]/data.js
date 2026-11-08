// GET /api/shop/:slug/data → the whole public shop page in one call:
// the shop, every listed member with its public booking data (settings,
// chosen services, busy blocks, redacted bookings, reviews) and the
// count-weighted rating. Members whose plan lapsed, who left or who were
// removed are not in it.
import { warmupDbOnce } from '../../_lib/db.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { publicShopPayload, validShopSlug } from '../../_lib/shops.js';
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
    const payload = await publicShopPayload(slug);
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
