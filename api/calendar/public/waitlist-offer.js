// GET /api/calendar/public/waitlist-offer?token=...
// What a waitlist claim link points at, for the public booking page:
// service, date and time, who it is for, and whether it is still open. The
// token is random (24 bytes) and stored hashed; nothing here changes state.
// Booking the spot is the normal POST /api/calendar/public/:slug with
// waitlistClaimToken (api/_lib/waitlist.js).
import { warmupDbOnce } from '../../_lib/db.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { loadOfferByToken, serializeOfferForClient } from '../../_lib/waitlist.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    await warmupDbOnce();
    await ensureSchemaApplied();
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [{ key: `wloffer:ip:${ip}`, max: 60, windowSeconds: 600 }]);
    if (blocked) return;
    const token = String(req.query.token || '').slice(0, 200);
    if (!token) return notFound(res, 'No such link');
    const offer = await loadOfferByToken(token);
    if (!offer) return notFound(res, 'No such link');
    return ok(res, { offer: serializeOfferForClient(offer) });
  } catch (err) {
    return serverError(res, err);
  }
}
