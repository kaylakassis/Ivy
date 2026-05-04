// /api/me/threads
//   GET  → list every message thread the user is a client in (across all
//          businesses). Each row carries clientId/workspaceId so the UI
//          can route taps to the right per-thread endpoint.
//   POST → start (or reuse) a thread with a specific business by clientId.
//          Returns the upserted thread.
//
// All access is filtered through clientPortal.myClientIds — a client can
// only ever see / write threads tied to their own client records.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import { serializeThread } from '../_lib/messages.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    const byClient = new Map(memberships.map((m) => [m.clientId, m]));

    if (req.method === 'GET') {
      if (myIds.length === 0) return ok(res, { threads: [] });

      const { rows } = await sql.query(
        `SELECT t.*, c.name AS client_name, c.email AS client_email
         FROM message_threads t
         JOIN clients c ON c.id = t.client_id AND c.workspace_id = t.workspace_id
         WHERE t.client_id = ANY($1)
         ORDER BY t.last_message_at DESC NULLS LAST, t.created_at DESC`,
        [myIds],
      );
      const threads = rows.map((r) => {
        const m = byClient.get(r.client_id);
        return {
          ...serializeThread(r),
          businessName: m?.businessName || 'Business',
          // From the client's perspective, the unread count that matters
          // is unread_client (messages they haven't seen from the biz).
        };
      });
      return ok(res, { threads });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const clientId = body.clientId ? String(body.clientId) : null;
      if (!clientId) return badRequest(res, 'clientId is required');
      if (!byClient.has(clientId)) return badRequest(res, 'Not your client record');

      const m = byClient.get(clientId);
      const r = await sql`
        INSERT INTO message_threads (workspace_id, client_id)
        VALUES (${m.workspaceId}, ${clientId})
        ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
        RETURNING *
      `;
      const row = {
        ...r.rows[0],
        client_name: m.clientName,
        client_email: m.clientEmail,
      };
      return created(res, {
        thread: { ...serializeThread(row), businessName: m.businessName },
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
