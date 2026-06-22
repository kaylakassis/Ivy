// /api/ivy/:id  - GET (session + messages) / DELETE
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedSession, serializeSession, serializeMessage } from '../_lib/ivy.js';
import { methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    // Ungated like /api/ivy (see comment there). Daily cap inside
    // generateReply is the throttle.
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const session = await fetchOwnedSession({ id, workspaceId });
    if (!session) return notFound(res, 'Session not found');

    if (req.method === 'GET') {
      // Defense-in-depth: re-scope ivy_messages SELECT by JOINing
      // ivy_sessions and filtering workspace_id. fetchOwnedSession
      // already gated the request, but the JOIN keeps the leak path
      // closed if that guard ever regresses.
      const { rows } = await sql`
        SELECT m.*
          FROM ivy_messages m
          JOIN ivy_sessions s ON s.id = m.session_id
         WHERE m.session_id = ${id}
           AND s.workspace_id = ${workspaceId}
         ORDER BY m.created_at ASC
      `;
      return ok(res, {
        session: serializeSession(session),
        messages: rows.map(serializeMessage),
      });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM ivy_sessions WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
