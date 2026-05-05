// POST /api/me/accept-terms { version }
//
// Records a user's acceptance of a versioned legal document. The
// version must match the current server-side CURRENT_TERMS_VERSION —
// we don't accept arbitrary version strings. Two writes:
//   1. Append a row to legal_acceptances (immutable audit trail with
//      IP + user_agent for evidentiary purposes).
//   2. Denormalize onto users.terms_version + terms_accepted_at so
//      auth/me can answer "have they accepted current?" with one
//      cheap column read.
//
// IMPORTANT — never delete legal_acceptances rows. They're our proof
// the user agreed to the version of the terms in effect at that time.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { getClientIp } from '../_lib/rate-limit.js';
import { CURRENT_TERMS_VERSION } from '../_lib/legal.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const body = await readBody(req);
    const version = (body.version || '').toString().trim();
    if (version !== CURRENT_TERMS_VERSION) {
      return badRequest(res, `Version mismatch. Server expects ${CURRENT_TERMS_VERSION}.`);
    }

    const ip = getClientIp(req);
    const ua = req.headers['user-agent']?.toString().slice(0, 500) || null;

    // Audit row (immutable).
    await sql`
      INSERT INTO legal_acceptances (user_id, document, version, ip, user_agent)
      VALUES (${user.id}, 'terms', ${version}, ${ip}, ${ua})
    `;
    // Denormalized snapshot for cheap reads.
    await sql`
      UPDATE users
      SET terms_version = ${version}, terms_accepted_at = NOW()
      WHERE id = ${user.id}
    `;

    return ok(res, {
      ok: true,
      version,
      acceptedAt: new Date().toISOString(),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
