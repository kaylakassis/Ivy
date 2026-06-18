// POST /api/auth/totp/disable   body: { password }
//
// Turns 2FA off. Requires the user's current password to confirm -
// a stolen session cookie can NOT disable 2FA without also knowing
// the password. Clears the secret + backup codes + enrolled_at in
// one UPDATE; once that lands, login.js no longer requires the
// challenge for this user.
//
// Re-enabling later goes through /enroll + /verify like the first
// time. No state is preserved across a disable.
import { sql } from '../../_lib/db.js';
import { requireUser, verifyPassword } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { enforce } from '../../_lib/rate-limit.js';
import { recordAudit } from '../../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError, unauthorized } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    // Cheap rate-limit on password-verify so a stolen-session
    // attacker can't brute-force the password offline through this
    // endpoint. 5 / minute / user.
    const blocked = await enforce(req, res, [
      { key: `totp:disable:${user.id}`, max: 5, windowSeconds: 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const password = String(body?.password || '');
    if (!password) return badRequest(res, 'Password is required to disable 2FA.');

    // Re-verify the password. Note: we use the bcrypt-stored hash on
    // users.password_hash. Not pulled into requireUser by default,
    // so we re-fetch.
    const { rows } = await sql`
      SELECT password_hash, totp_enrolled_at FROM users WHERE id = ${user.id}
    `;
    const row = rows[0];
    if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) {
      recordAudit(req, {
        actor: user, targetUserId: user.id,
        action: 'totp.disable.failed',
        meta: { reason: 'wrong_password' },
      });
      return unauthorized(res, 'Wrong password.');
    }

    await sql`
      UPDATE users SET
        totp_secret_encrypted    = NULL,
        totp_backup_codes_hashed = NULL,
        totp_enrolled_at         = NULL,
        updated_at               = NOW()
       WHERE id = ${user.id}
    `;

    recordAudit(req, {
      actor: user, targetUserId: user.id,
      action: 'totp.disabled',
      meta: { was_enrolled_at: row.totp_enrolled_at },
    });

    return ok(res, { ok: true, enrolled: false });
  } catch (err) {
    return serverError(res, err);
  }
}
