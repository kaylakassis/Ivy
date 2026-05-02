// POST /api/auth/signup  { email, password, name? }
import { sql } from '../_lib/db.js';
import { hashPassword, signSession, setSessionCookie, validEmail } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { createToken, KIND_VERIFY, appUrl } from '../_lib/tokens.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { badRequest, created, methodNotAllowed, serverError } from '../_lib/json.js';

const VERIFY_TTL_MIN = 60 * 24; // 24 hours

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const { email, password, name, mode } = await readBody(req);
    if (!validEmail(email)) return badRequest(res, 'Invalid email');
    if (typeof password !== 'string' || password.length < 8) {
      return badRequest(res, 'Password must be at least 8 characters');
    }
    // 'owner' (default) creates a workspace; 'client' does not — they're
    // signing up to view their bookings/invoices/messages from businesses
    // that already added them to a workspace as a client record.
    const role = mode === 'client' ? 'client' : 'owner';

    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `signup:ip:${ip}`, max: 5, windowSeconds: 10 * 60 },
    ]);
    if (blocked) return;

    const emailKey = email.toLowerCase();
    const existing = await sql`SELECT id FROM users WHERE email = ${emailKey}`;
    if (existing.rows.length > 0) return badRequest(res, 'Email already in use');

    const password_hash = await hashPassword(password);
    const insertUser = await sql`
      INSERT INTO users (email, password_hash, name)
      VALUES (${emailKey}, ${password_hash}, ${name || null})
      RETURNING id, email, name, created_at, email_verified_at
    `;
    const user = insertUser.rows[0];

    if (role === 'owner') {
      await sql`INSERT INTO workspaces (owner_id) VALUES (${user.id})`;
    } else {
      // Client signup: claim every existing `clients` row that already
      // matches this email so they immediately see their data when they
      // hit /me. Idempotent.
      await sql`
        UPDATE clients SET user_id = ${user.id}
        WHERE email = ${emailKey} AND user_id IS NULL
      `;
    }

    setSessionCookie(res, signSession(user.id));

    // Fire-and-(mostly)-forget the verification email — don't fail signup
    // if the email service hiccups.
    try {
      const raw = await createToken({ userId: user.id, kind: KIND_VERIFY, ttlMinutes: VERIFY_TTL_MIN });
      const link = `${appUrl()}/verify-email?token=${encodeURIComponent(raw)}`;
      await sendEmail({
        to: emailKey,
        subject: 'Confirm your email for THRYVE',
        html: emailShell({
          heading: 'Welcome to THRYVE',
          body: `<p>${user.name ? `Hi ${escapeHtml(user.name)},` : 'Hi,'}</p>
                 <p>Tap the button below to confirm this is your email. It keeps your account secure and unlocks email notifications.</p>
                 <p>This link expires in 24 hours.</p>`,
          ctaText: 'Confirm my email',
          ctaUrl: link,
          footer: `If you didn't create a THRYVE account, you can ignore this email.`,
        }),
      });
    } catch (mailErr) {
      // Log via response side-channel? No — just continue. User sees a banner
      // and can resend from inside the app.
      console.error('[signup] verification email failed:', mailErr.message);
    }

    return created(res, { user, role });
  } catch (err) {
    return serverError(res, err);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
