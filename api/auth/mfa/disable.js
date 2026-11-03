// POST /api/auth/mfa/disable   body: { password, method: 'email' | 'all' }
//
// Turns off email codes ('email') or every 2-step method ('all': email codes
// and the authenticator app, plus the backup codes). Needs the current
// password, so a stolen session cannot switch it off; admins "viewing as"
// someone cannot use it at all. The authenticator app alone is turned off by
// /api/auth/totp/disable. Sends the security email and writes an audit row.
import { sql } from '../../_lib/db.js';
import { requireUser, verifyPassword, invalidateUserCache, refuseImpersonated } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { recordAudit } from '../../_lib/audit.js';
import { notifyTwoFactorChanged } from '../../_lib/securityNotify.js';
import { badRequest, methodNotAllowed, ok, serverError, unauthorized } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (refuseImpersonated(req, res)) return;

    const blocked = await enforce(req, res, [
      { key: `mfa:disable:${user.id}`, max: 5, windowSeconds: 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const password = String(body?.password || '');
    const method = body?.method === 'all' ? 'all' : 'email';
    if (!password) return badRequest(res, 'Enter your password to turn off 2-step verification.');

    const { rows } = await sql`
      SELECT password_hash, totp_enrolled_at, mfa_email_enabled_at FROM users WHERE id = ${user.id}
    `;
    const row = rows[0];
    if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) {
      recordAudit(req, { actor: user, targetUserId: user.id, action: 'mfa.disable.failed', meta: { method, reason: 'wrong_password' } });
      return unauthorized(res, 'Wrong password.');
    }

    const totpStays = method === 'email' && !!row.totp_enrolled_at;
    if (totpStays) {
      await sql`UPDATE users SET mfa_email_enabled_at = NULL, updated_at = NOW() WHERE id = ${user.id}`;
    } else {
      // Nothing left guarding sign-in: clear every method and the backup codes.
      await sql`
        UPDATE users SET
          mfa_email_enabled_at     = NULL,
          totp_secret_encrypted    = NULL,
          totp_backup_codes_hashed = NULL,
          totp_enrolled_at         = NULL,
          updated_at               = NOW()
         WHERE id = ${user.id}
      `;
    }
    // Any live sign-in or setup code is void now.
    await sql`UPDATE mfa_email_codes SET consumed_at = NOW() WHERE user_id = ${user.id} AND consumed_at IS NULL`;

    const wasOn = !!(row.totp_enrolled_at || row.mfa_email_enabled_at);
    recordAudit(req, {
      actor: user, targetUserId: user.id,
      action: method === 'all' ? 'mfa.disabled' : 'mfa_email.disabled',
      meta: { was_email: row.mfa_email_enabled_at, was_totp: row.totp_enrolled_at, totp_stays: totpStays },
    });
    if (wasOn) {
      notifyTwoFactorChanged({
        userId: user.id, enabled: false,
        method: method === 'all' ? undefined : 'email', stillOn: totpStays,
        ip: getClientIp(req), userAgent: req.headers['user-agent'],
      });
    }
    invalidateUserCache(user.id);
    return ok(res, { ok: true, email: false, totp: totpStays });
  } catch (err) {
    return serverError(res, err);
  }
}
