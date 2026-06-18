// GET    /api/me/dms/:id  → thread + messages (clears my unread)
// DELETE /api/me/dms/:id  → archive for my side (the "leave" action)
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { myClientIds } from '../../_lib/clientPortal.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { serializeDmThread, serializeDmMessage } from '../../_lib/clientDms.js';
import { methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';

// Resolve the thread + my-side client_id in one query. Returns null
// if this user isn't on either side of the thread.
async function loadMyDm({ threadId, clientIds }) {
  const r = await sql.query(
    `SELECT t.*,
            CASE WHEN t.client_a_id = ANY($2::uuid[]) THEN t.client_a_id ELSE t.client_b_id END AS my_client_id,
            CASE WHEN t.client_a_id = ANY($2::uuid[]) THEN t.client_b_id ELSE t.client_a_id END AS other_client_id,
            CASE WHEN t.client_a_id = ANY($2::uuid[]) THEN cb.name ELSE ca.name END AS other_name,
            CASE WHEN t.client_a_id = ANY($2::uuid[]) THEN cb.email ELSE ca.email END AS other_email
       FROM client_dm_threads t
       JOIN clients ca ON ca.id = t.client_a_id
       JOIN clients cb ON cb.id = t.client_b_id
      WHERE t.id = $1
        AND (t.client_a_id = ANY($2::uuid[]) OR t.client_b_id = ANY($2::uuid[]))
      LIMIT 1`,
    [threadId, clientIds],
  );
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && !requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) return notFound(res, 'DM not found');
    const { id } = req.query;
    const thread = await loadMyDm({ threadId: id, clientIds });
    if (!thread) return notFound(res, 'DM not found');

    if (req.method === 'GET') {
      const myClientId = thread.my_client_id;
      // Messages - exclude any from a client the viewer has blocked
      // (blocker_client_id = me, blocked = sender).
      const msgs = await sql.query(
        `SELECT m.*
           FROM client_dm_messages m
          WHERE m.thread_id = $1
            AND m.workspace_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM client_dm_blocks b
               WHERE b.blocker_client_id = $3
                 AND b.blocked_client_id = m.sender_client_id
            )
          ORDER BY m.created_at ASC
          LIMIT 500`,
        [id, thread.workspace_id, myClientId],
      );
      // Clear my unread + reset my archive flag (the user is actively
      // viewing this thread).
      const meIsA = thread.client_a_id === myClientId;
      const colUnread = meIsA ? 'unread_a' : 'unread_b';
      const colArchive = meIsA ? 'archived_a' : 'archived_b';
      await sql.query(
        `UPDATE client_dm_threads SET ${colUnread} = 0, ${colArchive} = FALSE
          WHERE id = $1 AND workspace_id = $2`,
        [id, thread.workspace_id],
      );

      // Block + mute state for this pair.
      const flags = await sql`
        SELECT
          EXISTS (SELECT 1 FROM client_dm_blocks WHERE blocker_client_id = ${myClientId} AND blocked_client_id = ${thread.other_client_id}) AS blocked_by_me,
          EXISTS (SELECT 1 FROM client_dm_mutes WHERE muter_client_id = ${myClientId} AND muted_client_id = ${thread.other_client_id}) AS muted_by_me
      `;
      return ok(res, {
        dm: serializeDmThread({
          ...thread,
          blocked_by_me: flags.rows[0].blocked_by_me,
          muted_by_me: flags.rows[0].muted_by_me,
        }, myClientId),
        myClientId,
        otherClientId: thread.other_client_id,
        messages: msgs.rows.map((m) => serializeDmMessage(m, myClientId)),
      });
    }

    if (req.method === 'DELETE') {
      // Archive (leave) for my side only - the other side keeps history.
      const meIsA = thread.client_a_id === thread.my_client_id;
      const col = meIsA ? 'archived_a' : 'archived_b';
      await sql.query(
        `UPDATE client_dm_threads SET ${col} = TRUE WHERE id = $1 AND workspace_id = $2`,
        [id, thread.workspace_id],
      );
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
