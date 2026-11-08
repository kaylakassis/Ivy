// POST /api/shop/:slug/pv → one page view (counts only, no visitor data).
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { rateLimit, getClientIp } from '../../_lib/rate-limit.js';
import { recordPageView, validShopSlug } from '../../_lib/shops.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    await ensureSchemaApplied();
    const slug = String(req.query.slug || '').toLowerCase();
    if (!validShopSlug(slug)) return ok(res, { ok: true, counted: false });
    const ip = getClientIp(req);
    // One count per visitor per shop per 10 minutes, so a refresh loop
    // does not inflate the number the owner sees. A repeat is answered
    // quietly (counted: false) rather than with a 429 the visitor's
    // browser would log as an error.
    const lim = await rateLimit({ key: `shoppv:${ip}:${slug}`, max: 1, windowSeconds: 600 });
    if (!lim.allowed) return ok(res, { ok: true, counted: false });
    const counted = await recordPageView(slug);
    return ok(res, { ok: true, counted });
  } catch (err) {
    return serverError(res, err);
  }
}
