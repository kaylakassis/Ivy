// POST /api/auth/mfa/email-setup
//
// First half of turning on email 2-step verification, for any signed-in
// account (owner, client portal, helper). Sends a 6-digit setup code to the
// account's verified email; /api/auth/mfa/email-enable confirms it. Sign-in is
// not changed until that confirmation succeeds. Admins "viewing as" someone
// cannot use this.
import { sql } from '../../_lib/db.js';
import { requireUser, refuseImpersonated } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { recordAudit } from '../../_lib/audit.js';
import { sendEmailCode, MFA_EMAIL_COOLDOWN_SECONDS } from '../../_lib/mfaEmail.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (refuseImpersonated(req, res)) return;

    const { rows } = await sql`SELECT email_verified_at, mfa_email_enabled_at FROM users WHERE id = ${user.id}`;
    if (!rows[0]?.email_verified_at) {
      return badRequest(res, 'Confirm your email address first, using the link we emailed you. Then come back and turn this on.');
    }
    if (rows[0].mfa_email_enabled_at) return ok(res, { alreadyOn: true });

    const sent = await sendEmailCode({ userId: user.id, purpose: 'setup', req });
    if (!sent.ok) {
      if (sent.retryAfterSeconds) res.setHeader('Retry-After', String(sent.retryAfterSeconds));
      return res.status(sent.status || 500).json({ error: sent.error, retryAfterSeconds: sent.retryAfterSeconds || undefined });
    }
    recordAudit(req, { actor: user, targetUserId: user.id, action: 'mfa_email.enroll.initiated', meta: {} });
    return ok(res, { sent: true, email: sent.email, cooldownSeconds: MFA_EMAIL_COOLDOWN_SECONDS });
  } catch (err) {
    return serverError(res, err);
  }
}
