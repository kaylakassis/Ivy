// POST /api/admin/impersonate  { userId }
//
// Swaps the current admin session for a session impersonating the
// target user. Stashes the original token in `thryve_admin_session`
// (httpOnly) so the admin can call /api/admin/impersonate/stop to
// return to themselves without re-authenticating.
//
// The session JWT carries an `imp` claim noting the actor's user id.
// /api/auth/me reads that claim back so the UI can render an
// "impersonating" banner.
//
// Refuses to impersonate other super-admins (no privilege escalation
// loops) and refuses to start a nested impersonation.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor, emailIsSuperAdmin } from '../_lib/admin.js';
import {
  signSession, setImpersonationCookies, readImpersonationBackup,
} from '../_lib/auth.js';
import { recordAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    if (readImpersonationBackup(req)) {
      return badRequest(res, 'Already impersonating. Stop first.');
    }

    const actor = await getAdminActor(req);
    if (!actor?.id) return badRequest(res, 'Cannot impersonate from a header-secret session.');

    const { userId } = await readBody(req);
    if (!userId) return badRequest(res, 'userId is required');

    const r = await sql`SELECT id, email, user_type FROM users WHERE id = ${userId}`;
    if (r.rows.length === 0) return badRequest(res, 'User not found');
    const target = r.rows[0];
    const targetIsSuperAdmin = emailIsSuperAdmin(target.email) || target.user_type === 'super_admin';
    if (targetIsSuperAdmin && target.id !== actor.id) {
      return badRequest(res, 'Refusing to impersonate another super-admin.');
    }
    if (target.id === actor.id) return badRequest(res, "That's already you.");

    // Pull the actor's current cookie verbatim so we can restore exactly
    // what the browser had — re-signing would reset the expiry clock and
    // accidentally extend the session by 30 days each time.
    const cur = req.headers.cookie || '';
    const m = cur.match(/(?:^|;\s*)thryve_session=([^;]+)/);
    const backupToken = m ? decodeURIComponent(m[1]) : signSession(actor.id);

    const targetToken = signSession(target.id, { imp: actor.id });
    setImpersonationCookies(res, { backupToken, targetToken });

    await recordAudit(req, {
      actor, targetUserId: target.id, action: 'impersonate.start',
      meta: { targetEmail: target.email },
    });

    return ok(res, { ok: true, impersonating: { id: target.id, email: target.email } });
  } catch (err) {
    return serverError(res, err);
  }
}
