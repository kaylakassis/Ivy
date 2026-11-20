// POST /api/auth/signup-status { ticket }
//
// Asked by the "Check your email" screen while it waits: has the link been
// opened yet? Answers { confirmed: true|false } for the account the ticket
// is for. A ticket for nobody (handed out when the address already had an
// account) answers false forever, exactly like a real sign-up whose link
// has not been opened, so this cannot be used to tell the two apart.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { readSignupTicket } from '../_lib/signupTicket.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return undefined;
  try {
    await ensureSchemaApplied();
    // The screen asks every few seconds for a few minutes.
    if (await enforce(req, res, [{ key: `signup-status:ip:${getClientIp(req)}`, max: 600, windowSeconds: 60 * 60 }])) return undefined;
    res.setHeader('Cache-Control', 'no-store');
    const { ticket } = await readBody(req);
    const userId = readSignupTicket(ticket);
    if (!userId) return ok(res, { confirmed: false });
    const { rows } = await sql`
      SELECT 1 FROM users
       WHERE id = ${userId} AND deleted_at IS NULL
         AND email_verified_at IS NOT NULL AND confirm_required = FALSE`;
    return ok(res, { confirmed: rows.length > 0 });
  } catch (err) {
    return serverError(res, err);
  }
}
