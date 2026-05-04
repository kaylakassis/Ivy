// /api/messages
//   GET  → list threads for current workspace (joined with client name/email)
//   POST → create or return existing thread for a clientId

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { serializeThread } from '../_lib/messages.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { requireSameOrigin } from "../_lib/security.js";

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT t.*, c.name AS client_name, c.email AS client_email
        FROM message_threads t
        JOIN clients c ON c.id = t.client_id AND c.workspace_id = t.workspace_id
        WHERE t.workspace_id = ${workspaceId}
        ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
      `;
      return ok(res, { threads: rows.map(serializeThread) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const clientId = body.clientId ? String(body.clientId) : null;
      if (!clientId) return badRequest(res, 'clientId is required');

      // Verify client belongs to this workspace.
      const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
      if (cl.rows.length === 0) return badRequest(res, 'Unknown client');

      // Upsert: thread per (workspace, client) is unique.
      const r = await sql`
        INSERT INTO message_threads (workspace_id, client_id)
        VALUES (${workspaceId}, ${clientId})
        ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
        RETURNING *
      `;
      const thread = {
        ...r.rows[0],
        client_name: cl.rows[0].name,
        client_email: cl.rows[0].email,
      };
      return created(res, { thread: serializeThread(thread) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
