// POST /api/auth/totp/challenge   body: { code, mfaToken? }
//
// The SECOND factor of login. After /api/auth/login accepts the password for a
// user with 2-step verification on (authenticator app and/or email codes), it
// issues a 5-minute "mfa-pending" token (an httpOnly cookie on web, `mfaToken`
// in the body for native) INSTEAD of a session. This endpoint trades that
// token + a correct 6-digit code (from the app, or emailed by
// api/auth/mfa/send-code) or an unused backup code for a real session.
// readSession() refuses the mfa-pending token as a session, so it can't be
// replayed to skip this step.
import { sql, warmupDb, isConnectionError } from '../../_lib/db.js';
import {
  verifyMfaToken, readMfaCookie, clearMfaCookie,
  signSession, setSessionCookieClearingMfa, isNativeClient,
} from '../../_lib/auth.js';
import { emailIsSuperAdmin } from '../../_lib/admin.js';
import { readBody } from '../../_lib/body.js';
import { decrypt } from '../../_lib/secrets.js';
import { base32Decode, verifyTotp, hashBackupCode } from '../../_lib/totp.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { recordAudit } from '../../_lib/audit.js';
import { maybeNotifyNewSignIn } from '../../_lib/securityNotify.js';
import { verifyEmailCode, emailCodeError, hasTwoStep } from '../../_lib/mfaEmail.js';
import { badRequest, methodNotAllowed, ok, serverError, serviceUnavailable, unauthorized } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    await warmupDb();
    const body = await readBody(req);
    // Web sends the mfa token via the httpOnly cookie; native sends it in the body.
    const mfaToken = readMfaCookie(req) || (typeof body?.mfaToken === 'string' ? body.mfaToken : null);
    const userId = verifyMfaToken(mfaToken);
    if (!userId) {
      clearMfaCookie(res);
      return unauthorized(res, 'Your sign-in step expired. Please enter your password again.');
    }

    // 5 attempts / minute / user — same posture as totp/verify. Keyed on the
    // user (not IP) so a distributed brute-force still hits one shared cap.
    // Plus a per-IP ceiling so one machine can't work through many accounts.
    const blocked = await enforce(req, res, [
      { key: `totp:challenge:${userId}`, max: 5, windowSeconds: 60 },
      { key: `mfa:challenge:ip:${getClientIp(req)}`, max: 30, windowSeconds: 600 },
    ]);
    if (blocked) return;

    const code = String(body?.code || '').replace(/\s+/g, '');
    if (!code) return badRequest(res, 'Enter your 6-digit code, or a backup code.');

    const { rows } = await sql`
      SELECT id, email, name, created_at, email_verified_at, user_type,
             totp_secret_encrypted, totp_backup_codes_hashed, totp_enrolled_at,
             mfa_email_enabled_at
        FROM users WHERE id = ${userId} AND deleted_at IS NULL
    `;
    const user = rows[0];
    const totpOn = !!(user?.totp_enrolled_at && user?.totp_secret_encrypted);
    if (!user || !hasTwoStep(user) || (user.totp_enrolled_at && !totpOn && !user.mfa_email_enabled_at)) {
      // Enrollment vanished between login and challenge — refuse rather than
      // silently issuing a session without a real second factor.
      clearMfaCookie(res);
      return unauthorized(res, 'Two-factor is not set up on this account.');
    }

    let passed = false;
    let usedBackup = false;
    let via = null;
    let emailFail = null;

    if (/^\d{6}$/.test(code)) {
      // Authenticator app first (no side effects), then the emailed code.
      if (totpOn) {
        let secretBuf = null;
        try { secretBuf = base32Decode(decrypt(user.totp_secret_encrypted)); }
        catch (e) {
          console.error('[totp/challenge] decrypt failed for user', userId, e.message);
          if (!user.mfa_email_enabled_at) {
            return serverError(res, new Error('Could not read your 2FA secret. Re-enroll from Account → Security.'));
          }
        }
        if (secretBuf && verifyTotp(secretBuf, code, { drift: 1 })) { passed = true; via = 'totp'; }
      }
      if (!passed && user.mfa_email_enabled_at) {
        const r = await verifyEmailCode({ userId, purpose: 'login', code });
        if (r.ok) { passed = true; via = 'email'; }
        else emailFail = r.reason;
      }
    } else {
      // Backup-code path: stored as sha256 hashes with a used_at marker;
      // consume the first unused match (single-use).
      const wanted = hashBackupCode(code);
      const list = Array.isArray(user.totp_backup_codes_hashed) ? user.totp_backup_codes_hashed : [];
      const idx = list.findIndex((c) => c && c.hash === wanted && !c.used_at);
      if (idx >= 0) {
        list[idx] = { ...list[idx], used_at: new Date().toISOString() };
        await sql`UPDATE users SET totp_backup_codes_hashed = ${JSON.stringify(list)}::jsonb, updated_at = NOW() WHERE id = ${userId}`
          .catch((e) => console.warn('[totp/challenge] backup consume write failed:', e.message));
        passed = true;
        usedBackup = true;
        via = 'backup';
      }
    }

    if (!passed) {
      recordAudit(req, { actor: user, targetUserId: userId, action: 'auth.mfa_failed', meta: emailFail ? { email: emailFail } : {} });
      // Email-only accounts get the specific reason (expired, too many tries);
      // with an app on too, a mistyped app code reads the same as before.
      if (emailFail && !totpOn && emailFail !== 'wrong') return unauthorized(res, emailCodeError(emailFail));
      return unauthorized(res, "That code didn't match. Try again, or use a backup code.");
    }

    // Second factor cleared → issue the real session and drop the mfa token.
    const token = signSession(userId);
    setSessionCookieClearingMfa(res, token); // one Set-Cookie array (see auth.js)
    await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${userId}`
      .catch((e) => console.warn('[totp/challenge] last_login_at stamp failed:', e.message));
    maybeNotifyNewSignIn({ userId, ip: getClientIp(req), userAgent: req.headers['user-agent'] });
    recordAudit(req, { actor: user, action: 'auth.login', meta: { mfa: true, backup: usedBackup, via } });

    const payload = {
      user: {
        id: user.id, email: user.email, name: user.name,
        created_at: user.created_at, email_verified_at: user.email_verified_at,
        user_type: user.user_type,
        isSuperAdmin: emailIsSuperAdmin(user.email) || user.user_type === 'super_admin',
      },
    };
    if (isNativeClient(req)) payload.token = token;
    return ok(res, payload);
  } catch (err) {
    if (isConnectionError(err)) return serviceUnavailable(res);
    return serverError(res, err);
  }
}
