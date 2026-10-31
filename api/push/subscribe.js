// POST /api/push/subscribe   body: { endpoint, keys: { p256dh, auth }, userAgent? }
// Stores the browser-issued push subscription against the signed-in
// user. Idempotent on (user_id, endpoint) - re-subscribing from the
// same device just refreshes user_agent + last_used_at.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { isIpLiteral } from '../_lib/safeUrl.js';

// The browser push services we deliver to. The endpoint is user-supplied
// and the server POSTs to it later (api/_lib/push.js), so an endpoint on
// an arbitrary host would turn the push fanout into an SSRF primitive.
// Exact hosts, or the suffix for services that shard across subdomains.
const PUSH_HOSTS_EXACT = new Set([
  'push.services.mozilla.com',
  'updates.push.services.mozilla.com',
  'fcm.googleapis.com',
  'android.googleapis.com',
]);
const PUSH_HOST_SUFFIXES = [
  '.push.services.mozilla.com',
  '.push.apple.com',
  '.notify.windows.com',
  '.push.samsungosp.com',
];

// Exported for tests. Returns the normalized endpoint or null when the
// URL is not an https endpoint on a known push service.
export function allowedPushEndpoint(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host || isIpLiteral(host)) return null;
  const known = PUSH_HOSTS_EXACT.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
  if (!known) return null;
  return u.toString();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const rawEndpoint = body.endpoint ? String(body.endpoint) : null;
    const p256dh   = body.keys?.p256dh ? String(body.keys.p256dh) : null;
    const auth     = body.keys?.auth   ? String(body.keys.auth)   : null;
    const userAgent = body.userAgent ? String(body.userAgent).slice(0, 500) : null;

    if (!rawEndpoint || !p256dh || !auth) {
      return badRequest(res, 'endpoint + keys.p256dh + keys.auth are required');
    }
    const endpoint = allowedPushEndpoint(rawEndpoint);
    if (!endpoint) {
      return badRequest(res, 'endpoint must be an https URL on a known browser push service');
    }

    await sql`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key, user_agent, last_used_at)
      VALUES (${user.id}, ${endpoint}, ${p256dh}, ${auth}, ${userAgent}, NOW())
      ON CONFLICT (user_id, endpoint) DO UPDATE SET
        p256dh_key   = EXCLUDED.p256dh_key,
        auth_key     = EXCLUDED.auth_key,
        user_agent   = EXCLUDED.user_agent,
        last_used_at = NOW()
    `;
    return ok(res, { ok: true });
  } catch (err) {
    return serverError(res, err);
  }
}
