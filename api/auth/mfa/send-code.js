// POST /api/auth/mfa/send-code   body: { mfaToken? }
//
// Sign-in step only: emails a fresh 6-digit code to an account that has email
// 2-step verification on. Used by "Send a new code" and, for accounts that
// also have an authenticator app, "Email me a code instead". Needs the
// 5-minute MFA-pending token from /api/auth/login (httpOnly cookie on web,
// in the body for the iPhone app); a full session is not accepted here.
// Limits (api/_lib/mfaEmail.js): one code per 30 seconds, 5 per hour per
// account, 20 per hour per IP.
import { sql, warmupDb, isConnectionError } from '../../_lib/db.js';
import { verifyMfaToken, readMfaCookie, clearMfaCookie } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { recordAudit } from '../../_lib/audit.js';
import { sendEmailCode, MFA_EMAIL_COOLDOWN_SECONDS } from '../../_lib/mfaEmail.js';
import { badRequest, methodNotAllowed, ok, serverError, serviceUnavailable, unauthorized } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    await warmupDb();
    const body = await readBody(req);
    const mfaToken = readMfaCookie(req) || (typeof body?.mfaToken === 'string' ? body.mfaToken : null);
    const userId = verifyMfaToken(mfaToken);
    if (!userId) {
      clearMfaCookie(res);
      return unauthorized(res, 'Your sign-in step expired. Please enter your password again.');
    }
    const { rows } = await sql`
      SELECT id, email, mfa_email_enabled_at FROM users WHERE id = ${userId} AND deleted_at IS NULL
    `;
    const user = rows[0];
    if (!user) {
      clearMfaCookie(res);
      return unauthorized(res, 'Your sign-in step expired. Please enter your password again.');
    }
    if (!user.mfa_email_enabled_at) {
      return badRequest(res, 'Email codes are not turned on for this account. Use your authenticator app or a backup code.');
    }
    const sent = await sendEmailCode({ userId, purpose: 'login', req });
    if (!sent.ok) {
      if (sent.retryAfterSeconds) res.setHeader('Retry-After', String(sent.retryAfterSeconds));
      return res.status(sent.status || 500).json({ error: sent.error, retryAfterSeconds: sent.retryAfterSeconds || undefined });
    }
    recordAudit(req, { actor: user, targetUserId: userId, action: 'auth.mfa_email_sent', meta: { purpose: 'login' } });
    return ok(res, { sent: true, email: sent.email, cooldownSeconds: MFA_EMAIL_COOLDOWN_SECONDS });
  } catch (err) {
    if (isConnectionError(err)) return serviceUnavailable(res);
    return serverError(res, err);
  }
}
