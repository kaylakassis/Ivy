// POST /api/waitlist/join  { email, name?, source?, hp? }
//
// Public - no auth. Captures an email on the pre-launch waitlist. Mirrors
// the website form-submission spam controls: a hidden honeypot field and
// a per-IP rate limit. Idempotent: re-submitting the same email is a
// no-op success (never reveals "already on the list" - no enumeration).
//
// On first capture, fires a best-effort "you're on the list"
// confirmation email. Email failures never fail the request.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { validEmail } from '../_lib/auth.js';
import { sendEmail, emailShell } from '../_lib/email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    await ensureSchemaApplied();
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return badRequest(res, 'Invalid body');

    // Honeypot - silent-accept so the bot signal is hidden.
    if (body.hp) return ok(res, { received: true });

    const email = String(body.email || '').toLowerCase().trim();
    if (!validEmail(email)) return badRequest(res, 'Please enter a valid email');
    const name   = (body.name ? String(body.name) : '').trim().slice(0, 200) || null;
    const source = (body.source ? String(body.source) : 'landing').slice(0, 64);

    // 5 joins per IP per hour - honest visitors join once.
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `waitlist:${ip}`, max: 5, windowSeconds: 3600 }])) return;

    const ua = req.headers['user-agent']?.toString().slice(0, 500) || null;
    // Upsert keyed on the case-insensitive unique index. DO NOTHING on
    // conflict so a repeat submit is a clean no-op (no leak, no error).
    // RETURNING id is empty on conflict, which tells us first-vs-repeat.
    const inserted = await sql`
      INSERT INTO waitlist_signups (email, name, source, ip, user_agent)
      VALUES (${email}, ${name}, ${source}, ${ip}, ${ua})
      ON CONFLICT (LOWER(email)) DO NOTHING
      RETURNING id
    `;
    const isFirstTime = inserted.rows.length > 0;

    // Best-effort confirmation email on first capture only (so a repeat
    // submit doesn't re-spam them). Never block the response on email.
    if (isFirstTime) {
      try {
        await sendEmail({
          to: email,
          subject: "You're on the THRYVE waitlist 🎉",
          html: emailShell({
            heading: "You're on the list!",
            body: `<p>Thanks for joining the THRYVE waitlist${name ? `, ${escapeHtml(name.split(/\s+/)[0])}` : ''}.</p>
                   <p>We'll email you the moment we launch — and because you're an early supporter, you'll get <b>20% off for your first 12 months</b> when you sign up with this email address.</p>
                   <p>Talk soon 👋</p>`,
            footer: 'You received this because you joined the THRYVE waitlist.',
          }),
        });
      } catch (mailErr) {
        // eslint-disable-next-line no-console
        console.warn('[waitlist/join] confirmation email failed:', mailErr.message);
      }
    }

    return ok(res, { received: true });
  } catch (err) {
    return serverError(res, err);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
