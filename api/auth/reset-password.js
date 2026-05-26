// POST /api/auth/reset-password  { token, password }
// Verifies the reset token, sets a new password, signs the user in.
import { sql } from '../_lib/db.js';
import { hashPassword, signSession, setSessionCookie } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { findValidToken, consumeToken, invalidateUserTokens, KIND_RESET } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, ok, serverError, unauthorized } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const { token, password } = await readBody(req);
    if (typeof password !== 'string' || password.length < 8) {
      return badRequest(res, 'Password must be at least 8 characters');
    }

    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `reset:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const valid = await findValidToken({ kind: KIND_RESET, raw: token });
    if (!valid) return unauthorized(res, 'This reset link is invalid or has expired');

    const password_hash = await hashPassword(password);
    // Stamp password_changed_at so requireUser invalidates every JWT
    // issued before this moment — defends against an attacker who
    // already stole a session cookie (the password reset itself was
    // a proof-of-email-control, not a proof of session uniqueness).
    // Brief 1-second offset to NOW() so the freshly-signed cookie
    // below (which embeds iat at the same NOW()) still validates;
    // older sessions are decisively past.
    await sql`
      UPDATE users SET
        password_hash = ${password_hash},
        password_changed_at = NOW() - INTERVAL '1 second',
        updated_at = NOW()
      WHERE id = ${valid.userId}
    `;

    // Burn this token, plus any other live reset tokens for the user.
    await consumeToken(valid.tokenId);
    await invalidateUserTokens({ userId: valid.userId, kind: KIND_RESET });

    // Sign them in immediately — they just proved control of the email.
    setSessionCookie(res, signSession(valid.userId));
    const { rows } = await sql`SELECT id, email, name, created_at FROM users WHERE id = ${valid.userId}`;
    return ok(res, { user: rows[0] });
  } catch (err) {
    return serverError(res, err);
  }
}
