// /api/push/device - native (APNs) device-token registry.
//   POST   { token, platform? }  → register/refresh this device for the
//                                  signed-in user (upsert; a token moves
//                                  to a new user only once the old row is
//                                  stale, see below)
//   DELETE { token }             → unregister (sign-out, toggle off)
//
// The web-push sibling is /api/push/subscribe. Sends fan out from
// api/_lib/push.js sendPushToUser, which reads BOTH tables.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return methodNotAllowed(res, ['POST', 'DELETE']);
  }
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const token = body.token ? String(body.token).trim() : null;
    // APNs tokens are hex, historically 64 chars but Apple says treat
    // the length as opaque - cap generously, reject junk.
    if (!token || token.length < 16 || token.length > 400 || !/^[a-fA-F0-9]+$/.test(token)) {
      return badRequest(res, 'A valid device token is required');
    }

    if (req.method === 'DELETE') {
      // Only the owning user can unregister their row.
      await sql`DELETE FROM push_device_tokens WHERE token = ${token} AND user_id = ${user.id}`;
      return ok(res, { removed: true });
    }

    const platform = body.platform === 'android' ? 'android' : 'ios';
    // A token that is already registered only moves to another account
    // when it is STALE (no registration or delivery for 30 days). A live
    // token stays with its owner: otherwise anyone who learned a token
    // could register it under their own account and receive that person's
    // notifications. Legitimate account switches on one device are
    // unaffected because sign-out unregisters the token first
    // (src/lib/nativePush.js unregisterNativePush → DELETE below).
    const { rows } = await sql`
      INSERT INTO push_device_tokens (user_id, token, platform, last_used_at)
      VALUES (${user.id}, ${token}, ${platform}, NOW())
      ON CONFLICT (token) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        last_used_at = NOW()
      WHERE push_device_tokens.user_id = EXCLUDED.user_id
         OR push_device_tokens.last_used_at IS NULL
         OR push_device_tokens.last_used_at < NOW() - INTERVAL '30 days'
      RETURNING id
    `;
    if (rows.length === 0) {
      // Live token owned by another account. Not an error for the caller
      // (the OS may hand two accounts the same token on one device during
      // a switch); it simply is not theirs until the owner signs out.
      return ok(res, { registered: false, reason: 'token-in-use' });
    }
    return ok(res, { registered: true });
  } catch (err) {
    return serverError(res, err);
  }
}
