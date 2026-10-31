// GET /api/helper/invite?token=…  (public, rate-limited)
//
// Preview for the accept page: who invited you, which email the invite
// is for, and whether that email already has an Ivy account (so the page
// shows "sign in" vs "create your sign-in"). Invalid, used, cancelled and
// expired tokens all get the same 400 so the endpoint is not an oracle.
import { sql } from '../_lib/db.js';
import { readSession } from '../_lib/auth.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { findLiveInvite, deadInviteState } from '../_lib/helpers.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    await ensureSchemaApplied();
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `helper-invite:ip:${ip}`, max: 30, windowSeconds: 10 * 60 }])) return;

    const raw = typeof req.query.token === 'string' ? req.query.token : '';
    const invite = await findLiveInvite(raw);
    if (!invite) {
      // A link we issued but that no longer works: say which business and
      // why, so the page can show a friendly state instead of a dead end.
      const dead = await deadInviteState(raw);
      if (dead) {
        return res.status(410).json({
          error: dead.status === 'expired'
            ? `This invite link has expired. Ask ${dead.businessName} to send a new one.`
            : "Looks like you're no longer part of this team on Ivy.",
          status: dead.status,
          businessName: dead.businessName,
        });
      }
      return badRequest(res, 'This invite link is not valid. Ask the business to send a new one.');
    }

    const email = invite.email.toLowerCase();
    const existing = await sql`SELECT id FROM users WHERE LOWER(email) = ${email} AND deleted_at IS NULL LIMIT 1`;
    // Is the browser already signed in as the invitee? Lets the page
    // skip the password step. We only report a boolean, never the id.
    const session = readSession(req);
    let signedInAsInvitee = false;
    if (session?.sub && existing.rows[0]?.id === session.sub) signedInAsInvitee = true;

    return ok(res, {
      businessName: invite.biz_name || invite.workspace_name || 'A business',
      staffName: invite.staff_name,
      email,
      hasAccount: existing.rows.length > 0,
      signedInAsInvitee,
      expiresAt: invite.expires_at,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
