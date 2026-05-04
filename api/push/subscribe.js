// POST /api/push/subscribe   body: { endpoint, keys: { p256dh, auth }, userAgent? }
// Stores the browser-issued push subscription against the signed-in
// user. Idempotent on (user_id, endpoint) — re-subscribing from the
// same device just refreshes user_agent + last_used_at.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const endpoint = body.endpoint ? String(body.endpoint) : null;
    const p256dh   = body.keys?.p256dh ? String(body.keys.p256dh) : null;
    const auth     = body.keys?.auth   ? String(body.keys.auth)   : null;
    const userAgent = body.userAgent ? String(body.userAgent).slice(0, 500) : null;

    if (!endpoint || !p256dh || !auth) {
      return badRequest(res, 'endpoint + keys.p256dh + keys.auth are required');
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
