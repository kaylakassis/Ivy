// POST /api/auth/mfa/email-enable   body: { code }
//
// Second half of turning on email 2-step verification: checks the setup code
// from /api/auth/mfa/email-setup and stamps users.mfa_email_enabled_at, which
// is what /api/auth/login checks. If the account has no unused backup codes
// yet, 10 are made now and returned ONCE (stored hashed, shared with the
// authenticator-app method). Sends the "2-step is on" security email and
// writes an audit row. Admins "viewing as" someone cannot use this.
import { sql } from '../../_lib/db.js';
import { requireUser, invalidateUserCache, refuseImpersonated } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { recordAudit } from '../../_lib/audit.js';
import { notifyTwoFactorChanged } from '../../_lib/securityNotify.js';
import { generateBackupCodes, hashBackupCode } from '../../_lib/totp.js';
import { verifyEmailCode, emailCodeError } from '../../_lib/mfaEmail.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (refuseImpersonated(req, res)) return;

    const blocked = await enforce(req, res, [
      { key: `mfa:email:enable:${user.id}`, max: 5, windowSeconds: 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const code = String(body?.code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) return badRequest(res, 'Enter the 6-digit code we emailed you.');

    const { rows } = await sql`
      SELECT email_verified_at, mfa_email_enabled_at, totp_backup_codes_hashed
        FROM users WHERE id = ${user.id}
    `;
    const row = rows[0];
    if (!row?.email_verified_at) return badRequest(res, 'Confirm your email address first.');
    if (row.mfa_email_enabled_at) return ok(res, { ok: true, enabled: true, alreadyOn: true });

    const r = await verifyEmailCode({ userId: user.id, purpose: 'setup', code });
    if (!r.ok) {
      recordAudit(req, { actor: user, targetUserId: user.id, action: 'mfa_email.verify.failed', meta: { reason: r.reason } });
      return badRequest(res, emailCodeError(r.reason));
    }

    // Backup codes: keep an existing unused set (from the authenticator app),
    // otherwise make a fresh one to show once.
    const list = Array.isArray(row.totp_backup_codes_hashed) ? row.totp_backup_codes_hashed : [];
    const hasUnused = list.some((c) => c && !c.used_at);
    let backupCodes = null;
    if (!hasUnused) {
      backupCodes = generateBackupCodes(10);
      const hashed = backupCodes.map((c) => ({ hash: hashBackupCode(c), used_at: null }));
      await sql`
        UPDATE users SET mfa_email_enabled_at = NOW(),
               totp_backup_codes_hashed = ${JSON.stringify(hashed)}::jsonb, updated_at = NOW()
         WHERE id = ${user.id}
      `;
    } else {
      await sql`UPDATE users SET mfa_email_enabled_at = NOW(), updated_at = NOW() WHERE id = ${user.id}`;
    }

    recordAudit(req, { actor: user, targetUserId: user.id, action: 'mfa_email.enabled', meta: { new_backup_codes: !!backupCodes } });
    notifyTwoFactorChanged({ userId: user.id, enabled: true, method: 'email', ip: getClientIp(req), userAgent: req.headers['user-agent'] });
    invalidateUserCache(user.id);

    return ok(res, { ok: true, enabled: true, enabledAt: new Date().toISOString(), backupCodes });
  } catch (err) {
    return serverError(res, err);
  }
}
