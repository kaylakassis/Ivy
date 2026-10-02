// POST /api/early-access/invite  { token }
//
// Redeem a personal waitlist invite link. On a valid, unexpired token whose
// waitlist row still exists, set the ea_invite cookie so /signup (and the
// server-side check in auth/signup.js) lets this visitor through while the
// app is in waitlist mode.
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { verifyInviteToken, setInviteCookie } from '../_lib/earlyAccess.js';
import { sql } from '../_lib/db.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `ea-invite:${ip}`, max: 20, windowSeconds: 3600 }])) return;
    const body = await readBody(req);
    const token = body?.token ? String(body.token) : '';
    const data = verifyInviteToken(token);
    if (!data) return badRequest(res, 'This invite link is not valid or has expired. Ask for a new one.');
    const { rows } = await sql`SELECT 1 FROM waitlist_signups WHERE id = ${data.id} AND LOWER(email) = ${data.email} LIMIT 1`;
    if (!rows.length) return badRequest(res, 'This invite is no longer active.');
    setInviteCookie(res, token);
    return ok(res, { bypassed: true, email: data.email });
  } catch (err) {
    return serverError(res, err);
  }
}
