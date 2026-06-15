// /api/rewards/redemptions/:id
//   PATCH  → update status: 'used' (client cashed it in) | 'issued' (undo)
//   DELETE → remove redemption record entirely
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { serializeRedemption, VALID_REDEMPTION_STATUSES } from '../../_lib/rewards.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (!body.status || !VALID_REDEMPTION_STATUSES.has(body.status)) {
        return badRequest(res, 'status must be one of: issued, used, dismissed');
      }
      const usedAt = body.status === 'used' ? new Date().toISOString() : null;
      const upd = await sql`
        UPDATE reward_redemptions
        SET status = ${body.status},
            used_at = ${usedAt}
        WHERE id = ${id} AND workspace_id = ${workspaceId}
        RETURNING *
      `;
      if (upd.rows.length === 0) return notFound(res, 'Redemption not found');
      return ok(res, { redemption: serializeRedemption(upd.rows[0]) });
    }

    if (req.method === 'DELETE') {
      const r = await sql`
        DELETE FROM reward_redemptions WHERE id = ${id} AND workspace_id = ${workspaceId}
      `;
      if (r.rowCount === 0) return notFound(res, 'Redemption not found');
      return noContent(res);
    }

    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
