// POST /api/account/delete — irreversibly deletes the authenticated user's
// account and every row tied to it.
//
// Safety:
//   • Requires a JSON body { confirmEmail } that matches the user's email
//     (server-side check), so a malicious tab can't trigger deletion just
//     by sliding past CSRF.
//   • Requires the same-origin check + authenticated session.
//
// Cascade strategy: workspaces.owner_id has ON DELETE CASCADE → deleting
// the user row drops the workspace, which cascades to every workspace-
// scoped table. auth_tokens.user_id also cascades. We don't keep server
// logs of personal data so there's nothing more to scrub.
//
// After delete we clear the session cookie so the browser is signed out.
import { sql } from '../_lib/db.js';
import { requireUser, clearSessionCookie } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;

  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const body = await readBody(req);
    const confirmEmail = (body.confirmEmail || '').toString().trim().toLowerCase();

    if (!confirmEmail) {
      return badRequest(res, 'confirmEmail is required');
    }
    if (confirmEmail !== (user.email || '').toLowerCase()) {
      return badRequest(res, "Email doesn't match the account we're about to delete");
    }

    // Delete the user. Cascades to workspaces → all workspace-scoped tables,
    // and to auth_tokens. Returns the row count for sanity.
    const r = await sql`DELETE FROM users WHERE id = ${user.id}`;

    clearSessionCookie(res);
    return ok(res, { deleted: r.rowCount > 0 });
  } catch (err) {
    return serverError(res, err);
  }
}
