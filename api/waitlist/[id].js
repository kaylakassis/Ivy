// DELETE /api/waitlist/:id - owner removes a waitlist entry. Doesn't
// delete the row (keeps audit trail) - just sets status='cancelled'
// so it stops competing for promotion slots.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, noContent, notFound, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    const r = await sql`
      UPDATE waitlist_entries SET status = 'cancelled'
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = 'waiting'
    `;
    if (r.rowCount === 0) return notFound(res, 'Waitlist entry not found or already processed');
    return noContent(res);
  } catch (err) {
    return serverError(res, err);
  }
}
