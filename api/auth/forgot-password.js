// POST /api/auth/forgot-password  { email }
// Always returns 200 — we never reveal whether an email exists.
import { sql } from '../_lib/db.js';
import { validEmail } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { createToken, KIND_RESET, appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

const TTL_MINUTES = 60; // reset links last 1 hour

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const { email } = await readBody(req);
    const emailKey = typeof email === 'string' ? email.toLowerCase().trim() : '';

    // Rate-limit aggressively: this endpoint sends real emails.
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `forgot:ip:${ip}`,        max: 5, windowSeconds: 60 * 60 },
      { key: `forgot:email:${emailKey}`, max: 3, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    // Look up the user. If they don't exist, we still respond OK
    // (don't leak whether the email is registered).
    if (!validEmail(emailKey)) return ok(res, { sent: true });

    const { rows } = await sql`SELECT id, name FROM users WHERE email = ${emailKey}`;
    if (rows.length === 0) return ok(res, { sent: true });

    const user = rows[0];
    const raw = await createToken({ userId: user.id, kind: KIND_RESET, ttlMinutes: TTL_MINUTES });
    const link = `${appUrl()}/reset-password?token=${encodeURIComponent(raw)}`;

    await sendEmail({
      to: emailKey,
      subject: 'Reset your THRYVE password',
      html: emailShell({
        heading: 'Reset your password',
        body: `<p>${user.name ? `Hi ${escapeHtml(user.name)},` : 'Hi,'}</p>
               <p>We got a request to reset your THRYVE password. Click the button below and you'll be taken to a page where you can pick a new one.</p>
               <p>This link expires in ${TTL_MINUTES} minutes.</p>`,
        ctaText: 'Reset my password',
        ctaUrl: link,
        footer: `If you didn't ask to reset your password, you can ignore this email — your account stays as is.`,
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
