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
import { mirrorToSheet } from '../_lib/waitlistSheet.js';

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
    const clean = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
    const firstName = clean(body.firstName, 80) || null;
    const lastName  = clean(body.lastName, 80) || null;
    // Legacy callers send a single `name`; split it so the sheet columns fill.
    const legacy = clean(body.name, 200);
    const first = firstName || (legacy ? legacy.split(/\s+/)[0] : null);
    const last  = lastName  || (legacy ? legacy.split(/\s+/).slice(1).join(' ') || null : null);
    if (!first) return badRequest(res, 'Please enter your first name');
    if (!last)  return badRequest(res, 'Please enter your last name');
    const name = [first, last].filter(Boolean).join(' ');
    const phoneRaw = clean(body.phone, 40);
    const phone = phoneRaw ? phoneRaw.replace(/[^\d+() .-]/g, '') : null;
    if (phone && phone.replace(/\D/g, '').length < 7) return badRequest(res, 'That phone number looks too short');
    const consent = body.consent === true || body.consent === 'true' || body.consent === 'yes';
    if (!consent) return badRequest(res, 'Please tick the box so we can let you know when Ivy is live');
    const source = (body.source ? String(body.source) : 'landing').slice(0, 64);

    // 5 joins per IP per hour - honest visitors join once.
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `waitlist:${ip}`, max: 5, windowSeconds: 3600 }])) return;

    const ua = req.headers['user-agent']?.toString().slice(0, 500) || null;
    // Upsert keyed on the case-insensitive unique index. DO NOTHING on
    // conflict so a repeat submit is a clean no-op (no leak, no error).
    // RETURNING id is empty on conflict, which tells us first-vs-repeat.
    // A repeat submit fills in anything the earlier row was missing (an
    // email-only signup from the old form) but never overwrites what is
    // there. xmax = 0 tells us whether this was the first time.
    const inserted = await sql`
      INSERT INTO waitlist_signups (email, name, first_name, last_name, phone, contact_consent, consent_at, source, ip, user_agent)
      VALUES (${email}, ${name}, ${first}, ${last}, ${phone}, ${consent}, NOW(), ${source}, ${ip}, ${ua})
      ON CONFLICT (LOWER(email)) DO UPDATE SET
        first_name      = COALESCE(waitlist_signups.first_name, EXCLUDED.first_name),
        last_name       = COALESCE(waitlist_signups.last_name,  EXCLUDED.last_name),
        name            = COALESCE(waitlist_signups.name,       EXCLUDED.name),
        phone           = COALESCE(waitlist_signups.phone,      EXCLUDED.phone),
        contact_consent = COALESCE(waitlist_signups.contact_consent, EXCLUDED.contact_consent),
        consent_at      = COALESCE(waitlist_signups.consent_at, EXCLUDED.consent_at)
      RETURNING id, created_at, (xmax = 0) AS is_new
    `;
    const isFirstTime = !!inserted.rows[0]?.is_new;
    if (isFirstTime) {
      // Google Sheet mirror: never awaited past the response, never fatal.
      mirrorToSheet({ createdAt: inserted.rows[0].created_at, firstName: first, lastName: last, email, phone, consent, source }).catch(() => {});
    }

    // Best-effort confirmation email on first capture only (so a repeat
    // submit doesn't re-spam them). Never block the response on email.
    if (isFirstTime) {
      try {
        await sendEmail({
          to: email,
          subject: "You're on the Ivy waitlist 🎉",
          html: emailShell({
            heading: "You're on the list!",
            body: `<p>Thanks for joining the Ivy waitlist${name ? `, ${escapeHtml(name.split(/\s+/)[0])}` : ''}.</p>
                   <p>We'll email you the moment we launch — and because you're an early supporter, you'll get <b>20% off for your first 12 months</b> when you sign up with this email address.</p>
                   <p>Talk soon 👋</p>`,
            footer: 'You received this because you joined the Ivy waitlist.',
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
