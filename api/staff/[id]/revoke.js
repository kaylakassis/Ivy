// POST /api/staff/:id/revoke
//
// Owner-only. Detaches the helper's login from this staff record:
// user_id cleared, revoked_at stamped, pending links cancelled. Their
// next request to any /api/helper/* endpoint is refused (the membership
// cache is invalidated here, so it is immediate). The staff record and
// every historical booking assignment stay put.
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { fetchOwnedStaff, serializeStaff } from '../../_lib/staff.js';
import { helperFieldsFor, revokeHelper } from '../../_lib/helpers.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;
    const staff = await fetchOwnedStaff({ id, workspaceId });
    if (!staff) return notFound(res, 'Staff member not found');
    if (!staff.user_id) return badRequest(res, 'This staff member does not have a login to revoke.');

    await revokeHelper({ workspaceId, staffId: id });
    const row = await fetchOwnedStaff({ id, workspaceId });
    return ok(res, { staff: serializeStaff(row, helperFieldsFor(row, null)) });
  } catch (err) {
    return serverError(res, err);
  }
}
