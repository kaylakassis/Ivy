// /api/staff/:id/invite
//   POST   → invite this staff member to Ivy as a helper (or resend: a
//            fresh signed link; earlier pending links stop working)
//   DELETE → cancel the pending invite
//
// Owner-only. Seats, owner-email refusal and the email itself live in
// api/_lib/helpers.js so "Add helper" (POST /api/staff { invite: true })
// behaves identically.
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { fetchOwnedStaff, serializeStaff } from '../../_lib/staff.js';
import { cancelHelperInvite, helperFieldsFor, inviteHelper, pendingInvitesByStaff, HelperError, setHelperPermissions } from '../../_lib/helpers.js';
import { readBody } from '../../_lib/body.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return methodNotAllowed(res, ['POST', 'DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;
    const staff = await fetchOwnedStaff({ id, workspaceId });
    if (!staff) return notFound(res, 'Staff member not found');

    if (req.method === 'POST') {
      // Permissions chosen on the invite form travel with the invite so
      // the email can list them.
      const body = await readBody(req);
      if (body && typeof body.permissions === 'object' && body.permissions) {
        staff.permissions = await setHelperPermissions({ workspaceId, staffId: id, permissions: body.permissions });
      }
      let invite;
      try {
        invite = await inviteHelper({ workspaceId, owner: user, staff });
      } catch (e) {
        if (e instanceof HelperError) return res.status(e.status).json({ error: e.message });
        throw e;
      }
      const row = await fetchOwnedStaff({ id, workspaceId });
      return ok(res, {
        staff: serializeStaff(row, helperFieldsFor(row, { expiresAt: invite.expiresAt })),
        sent: invite.sent,
        reason: invite.reason,
        abilities: invite.abilities,
      });
    }

    await cancelHelperInvite({ workspaceId, staffId: id });
    const row = await fetchOwnedStaff({ id, workspaceId });
    const pending = await pendingInvitesByStaff(workspaceId);
    return ok(res, { staff: serializeStaff(row, helperFieldsFor(row, pending.get(id))) });
  } catch (err) {
    return serverError(res, err);
  }
}
