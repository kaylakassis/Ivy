// POST   /api/me/dms/:id/block   → block the other party
// DELETE /api/me/dms/:id/block   → unblock
//
// A block prevents the blocked client from sending DMs to me (the
// /api/me/dms/[id]/messages POST hard-rejects with 403) AND filters the
// blocked client's existing messages out of my fetch.
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { myClientIds } from '../../../_lib/clientPortal.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { methodNotAllowed, noContent, notFound, ok, serverError } from '../../../_lib/json.js';

async function loadPair({ threadId, clientIds }) {
  const r = await sql.query(
    `SELECT t.workspace_id,
            CASE WHEN t.client_a_id = ANY($2::uuid[]) THEN t.client_a_id ELSE t.client_b_id END AS my_client_id,
            CASE WHEN t.client_a_id = ANY($2::uuid[]) THEN t.client_b_id ELSE t.client_a_id END AS other_client_id
       FROM client_dm_threads t
      WHERE t.id = $1
        AND (t.client_a_id = ANY($2::uuid[]) OR t.client_b_id = ANY($2::uuid[]))
      LIMIT 1`,
    [threadId, clientIds],
  );
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) return notFound(res, 'DM not found');
    const pair = await loadPair({ threadId: req.query.id, clientIds });
    if (!pair) return notFound(res, 'DM not found');

    if (req.method === 'POST') {
      await sql`
        INSERT INTO client_dm_blocks (blocker_client_id, blocked_client_id, workspace_id)
        VALUES (${pair.my_client_id}, ${pair.other_client_id}, ${pair.workspace_id})
        ON CONFLICT DO NOTHING
      `;
      return ok(res, { blocked: true });
    }
    if (req.method === 'DELETE') {
      await sql`
        DELETE FROM client_dm_blocks
         WHERE blocker_client_id = ${pair.my_client_id}
           AND blocked_client_id = ${pair.other_client_id}
      `;
      return noContent(res);
    }
    return methodNotAllowed(res, ['POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
