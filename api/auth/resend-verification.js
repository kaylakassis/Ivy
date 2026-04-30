// POST /api/auth/resend-verification — auth-required; resend the verification email
// to the current user. No-op if already verified.
import { requireUser } from '../_lib/auth.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { createToken, invalidateUserTokens, KIND_VERIFY, appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

const VERIFY_TTL_MIN = 60 * 24;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (user.email_verified_at) return ok(res, { sent: false, alreadyVerified: true });

    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `resend-verify:user:${user.id}`, max: 3, windowSeconds: 60 * 60 },
      { key: `resend-verify:ip:${ip}`,        max: 5, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    // Burn any older live tokens so only the latest link works.
    await invalidateUserTokens({ userId: user.id, kind: KIND_VERIFY });

    const raw = await createToken({ userId: user.id, kind: KIND_VERIFY, ttlMinutes: VERIFY_TTL_MIN });
    const link = `${appUrl()}/verify-email?token=${encodeURIComponent(raw)}`;

    await sendEmail({
      to: user.email,
      subject: 'Confirm your email for THRYVE',
      html: emailShell({
        heading: 'Confirm your email',
        body: `<p>Hi${user.name ? ` ${escapeHtml(user.name)}` : ''},</p>
               <p>Click below to confirm your email and unlock notifications.</p>
               <p>This link expires in 24 hours.</p>`,
        ctaText: 'Confirm my email',
        ctaUrl: link,
        footer: `If you didn't request this, you can ignore the email.`,
      }),
    });

    return ok(res, { sent: true });
  } catch (err) {
    return serverError(res, err);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
