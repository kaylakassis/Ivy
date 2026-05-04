// POST /api/admin/impersonate/stop
//
// Restores the admin's original session by swapping the backup cookie
// back into the main session slot, then clearing the backup. Verifies
// the backup is for the same user as the `imp` claim so a stale
// backup can't be used to escalate.
import jwt from 'jsonwebtoken';
import { requireSameOrigin } from '../../_lib/security.js';
import {
  readSession, readImpersonationBackup, restoreFromImpersonation,
} from '../../_lib/auth.js';
import { recordAudit } from '../../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const session = readSession(req);
    if (!session) return badRequest(res, 'Not signed in.');
    const impersonatedUserId = session.sub;
    const actorUserId        = session.imp;
    if (!actorUserId) return badRequest(res, 'Not impersonating anyone.');

    const backup = readImpersonationBackup(req);
    if (!backup) return badRequest(res, 'No impersonation backup found.');

    // Verify the backup token is signed by us and belongs to the actor
    // recorded in the imp claim. If not, refuse — something's tampered.
    let backupClaims;
    try {
      backupClaims = jwt.verify(backup, process.env.JWT_SECRET);
    } catch {
      return badRequest(res, 'Backup token invalid.');
    }
    if (backupClaims.sub !== actorUserId) {
      return badRequest(res, 'Backup token does not match impersonation actor.');
    }

    restoreFromImpersonation(res, backup);

    await recordAudit(req, {
      actor: { id: actorUserId, email: null },
      targetUserId: impersonatedUserId,
      action: 'impersonate.stop',
      meta: {},
    });

    return ok(res, { ok: true });
  } catch (err) {
    return serverError(res, err);
  }
}
