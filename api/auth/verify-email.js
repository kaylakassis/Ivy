// POST /api/auth/verify-email  { token }
// Marks the user's email_verified_at and burns the token.
//
// Idempotent — email security scanners (Gmail / Outlook / Apple Mail
// link-preview) often prefetch the link and trigger one verification
// silently. If a SECOND click finds the token already consumed but the
// user IS verified, we return 200 instead of 401 so the user doesn't
// see "this link is invalid" after a successful first hit.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { findValidToken, consumeToken, KIND_VERIFY } from '../_lib/tokens.js';
import { methodNotAllowed, ok, serverError, unauthorized } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    // Heavy per-IP cap. Token guessing is the abuse vector — without
    // a limit, a bot can iterate through token-space looking for
    // bad-token oracle behavior. 30/hr/IP is generous for any
    // real user (they typically click the link 1-3 times).
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `verify-email:ip:${ip}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const { token } = await readBody(req);
    const valid = await findValidToken({ kind: KIND_VERIFY, raw: token });
    if (!valid) return unauthorized(res, 'This verification link is invalid or has expired');

    // Read the user row regardless of whether the token's been used yet.
    const { rows } = await sql`
      SELECT id, email, name, created_at, email_verified_at
      FROM users WHERE id = ${valid.userId}
    `;
    const user = rows[0];
    if (!user) return unauthorized(res, 'This verification link is invalid or has expired');

    if (valid.alreadyUsed) {
      // Idempotent path. If the user is already verified, this is just
      // a duplicate click — return success. If they're somehow NOT
      // verified (token used but user.email_verified_at is still null —
      // shouldn't happen but worth handling), we don't trust the stale
      // token and reject. The user can sign in and hit "Resend".
      if (user.email_verified_at) {
        return ok(res, { user, alreadyVerified: true });
      }
      return unauthorized(res, 'This verification link is invalid or has expired');
    }

    await sql`
      UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW())
      WHERE id = ${valid.userId}
    `;
    await consumeToken(valid.tokenId);

    // Re-read so the response carries the freshly-set email_verified_at.
    const refreshed = await sql`
      SELECT id, email, name, created_at, email_verified_at
      FROM users WHERE id = ${valid.userId}
    `;
    return ok(res, { user: refreshed.rows[0] });
  } catch (err) {
    return serverError(res, err);
  }
}
