// DELETE /api/rewards/redemptions/:id
import { sql } from '../../_lib/db.js';
import { requireUser, ensureWorkspace } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { methodNotAllowed, noContent, notFound, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const r = await sql`
      DELETE FROM reward_redemptions WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
    if (r.rowCount === 0) return notFound(res, 'Redemption not found');
    return noContent(res);
  } catch (err) {
    return serverError(res, err);
  }
}
