// POST /api/shop/:slug/pv → one page view (counts only, no visitor data).
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { recordPageView } from '../../_lib/shops.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    await ensureSchemaApplied();
    const slug = String(req.query.slug || '').toLowerCase();
    const ip = getClientIp(req);
    // One count per visitor per shop per 10 minutes, so a refresh loop
    // does not inflate the number the owner sees.
    if (await enforce(req, res, [{ key: `shoppv:${ip}:${slug}`, max: 1, windowSeconds: 600 }])) return;
    await recordPageView(slug);
    return ok(res, { ok: true });
  } catch (err) {
    return serverError(res, err);
  }
}
