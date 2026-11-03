// POST /api/auth/reset-password  { token, password }
// Verifies the reset token, sets a new password, signs the user in.
import { sql } from '../_lib/db.js';
import {
  hashPassword, signSession, setSessionCookie, invalidateUserCache, isNativeClient,
} from '../_lib/auth.js';
import { beginMfaStep, hasTwoStep } from '../_lib/mfaEmail.js';
import { validatePassword } from '../_lib/passwordPolicy.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { findValidToken, consumeToken, invalidateUserTokens, KIND_RESET } from '../_lib/tokens.js';
import { recordAudit } from '../_lib/audit.js';
import { notifyPasswordChanged } from '../_lib/securityNotify.js';
import { badRequest, methodNotAllowed, ok, serverError, unauthorized } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const { token, password } = await readBody(req);
    const pwCheck = validatePassword(password);
    if (!pwCheck.ok) return badRequest(res, pwCheck.error);

    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `reset:ip:${ip}`, max: 10, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const valid = await findValidToken({ kind: KIND_RESET, raw: token });
    // A reset link works exactly once. A used link is as dead as an expired
    // one, and the token is burned BEFORE the password changes so two
    // simultaneous submissions cannot both set a password.
    if (!valid || valid.alreadyUsed) return unauthorized(res, 'This reset link is invalid or has expired');
    if (!(await consumeToken(valid.tokenId))) {
      return unauthorized(res, 'This reset link is invalid or has expired');
    }

    const password_hash = await hashPassword(password);
    // Stamp password_changed_at so requireUser invalidates every JWT
    // issued before this moment - defends against an attacker who
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

    // Bust the cached user row so requireUser sees the new
    // password_changed_at immediately — without this, any session
    // running on a warm function instance that has the old row cached
    // would survive for up to the cache TTL after the reset.
    invalidateUserCache(valid.userId);

    // Burn any other live reset tokens for the user.
    await invalidateUserTokens({ userId: valid.userId, kind: KIND_RESET });

    const { rows } = await sql`SELECT id, email, name, created_at, totp_enrolled_at, mfa_email_enabled_at FROM users WHERE id = ${valid.userId}`;
    recordAudit(req, { actor: rows[0], action: 'auth.password_reset', meta: {} });
    // "Your password was changed" security alert. Fire-and-forget.
    notifyPasswordChanged({ userId: valid.userId, ip, userAgent: req.headers['user-agent'] });

    // Control of the inbox proves the email, not the second factor. An
    // account with 2FA enrolled gets the same MFA-pending step as login
    // instead of a session.
    if (hasTwoStep(rows[0])) {
      return ok(res, await beginMfaStep(req, res, rows[0]));
    }

    // Sign them in immediately - they just proved control of the email.
    const sessionToken = signSession(valid.userId);
    setSessionCookie(res, sessionToken);
    const { totp_enrolled_at: _t, mfa_email_enabled_at: _m, ...user } = rows[0];
    const payload = { user };
    if (isNativeClient(req)) payload.token = sessionToken;
    return ok(res, payload);
  } catch (err) {
    return serverError(res, err);
  }
}
