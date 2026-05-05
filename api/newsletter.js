// POST /api/newsletter   { email, source? }
//
// Public endpoint — no auth. Stores an email in newsletter_subscribers
// for later batch sending. Idempotent on duplicate email (returns OK
// without re-inserting). Rate-limited per IP so a script can't dump
// 10k addresses into the table.
import { sql } from './_lib/db.js';
import { readBody } from './_lib/body.js';
import { validEmail } from './_lib/auth.js';
import { enforce, getClientIp } from './_lib/rate-limit.js';
import { badRequest, methodNotAllowed, ok, serverError } from './_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const body = await readBody(req);
    const email = (body.email || '').toString().trim().toLowerCase();
    const source = body.source ? String(body.source).slice(0, 40) : null;

    if (!validEmail(email)) return badRequest(res, 'Invalid email');

    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `newsletter:ip:${ip}`, max: 5, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const ua = req.headers['user-agent']?.toString().slice(0, 500) || null;

    // Idempotent on email — return OK whether the insert happened or
    // the row already existed. We don't leak "already subscribed" to
    // avoid being a subscription-checking oracle.
    await sql`
      INSERT INTO newsletter_subscribers (email, source, ip, user_agent)
      VALUES (${email}, ${source}, ${ip}, ${ua})
      ON CONFLICT (email) DO UPDATE SET unsubscribed_at = NULL
    `;

    return ok(res, { ok: true });
  } catch (err) {
    return serverError(res, err);
  }
}
