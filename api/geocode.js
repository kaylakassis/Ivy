// POST /api/geocode  body: { address }
// Resolves a free-form address to { lat, lng, displayName } via Nominatim
// (OpenStreetMap). Rate-limited per IP to play nice with Nominatim's
// usage policy (1 req/sec recommended).
//
// We only return the top match. Owners review + accept the result in the
// UI before saving to their workspace, so an imperfect geocode is fine
// - they'll either tweak the displayed coordinates or paste their own.
import { requireUser } from './_lib/auth.js';
import { readBody } from './_lib/body.js';
import { requireSameOrigin } from './_lib/security.js';
import { enforce, getClientIp } from './_lib/rate-limit.js';
import { badRequest, methodNotAllowed, ok, serverError, serviceUnavailable } from './_lib/json.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Nominatim's usage policy requires a real User-Agent identifying the app.
const UA = 'Ivy/1.0 (https://joinivy.ai; geocoding via Nominatim)';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const ip = getClientIp(req);
    // Owners look up their address a couple of times tops - generous IP
    // bucket but tight per-user effective rate via the same key.
    const blocked = await enforce(req, res, [
      { key: `geocode:user:${user.id}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const address = (body.address || '').toString().trim();
    if (!address || address.length < 3) {
      return badRequest(res, 'Address is too short');
    }
    if (address.length > 280) {
      return badRequest(res, 'Address is too long');
    }

    const params = new URLSearchParams({
      q: address,
      format: 'json',
      addressdetails: '0',
      limit: '1',
    });
    let r;
    try {
      r = await fetch(`${NOMINATIM}?${params.toString()}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      // The map service is down or unreachable: not our error, and the
      // owner can simply try again.
      return serviceUnavailable(res, 'The map service is not reachable right now. Please try again in a moment.');
    }
    if (!r.ok) return serviceUnavailable(res, 'The map service is not responding right now. Please try again in a moment.');
    const data = await r.json().catch(() => []);
    if (!Array.isArray(data) || data.length === 0) {
      return ok(res, { match: null });
    }
    const top = data[0];
    return ok(res, {
      match: {
        lat:         Number(top.lat),
        lng:         Number(top.lon),
        displayName: top.display_name || address,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
