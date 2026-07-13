// /api/me/dms
//   GET  → list this user's DM threads (non-archived for their side)
//   POST → start { recipientClientId } - requires shared active group
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { myClientIds } from '../../_lib/clientPortal.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import {
  sharedGroupWorkspace, getOrCreateDmThread, serializeDmThread,
} from '../../_lib/clientDms.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res) && req.method !== 'GET') return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) {
      if (req.method === 'GET') return ok(res, { dms: [] });
      return badRequest(res, 'No client profile');
    }

    if (req.method === 'GET') {
      // List every thread where ANY of my client-rows is the a OR b side,
      // not archived for that side. We don't surface other workspace's
      // owners - DMs are strictly client↔client.
      const r = await sql.query(
        `SELECT t.*,
                CASE WHEN t.client_a_id = ANY($1::uuid[]) THEN t.client_b_id ELSE t.client_a_id END AS other_id,
                CASE WHEN t.client_a_id = ANY($1::uuid[]) THEN cb.name ELSE ca.name END AS other_name,
                CASE WHEN t.client_a_id = ANY($1::uuid[]) THEN cb.email ELSE ca.email END AS other_email,
                CASE WHEN t.client_a_id = ANY($1::uuid[]) THEN t.client_a_id ELSE t.client_b_id END AS my_client_id,
                EXISTS (SELECT 1 FROM client_dm_blocks b
                         WHERE b.blocker_client_id = (CASE WHEN t.client_a_id = ANY($1::uuid[]) THEN t.client_a_id ELSE t.client_b_id END)
                           AND b.blocked_client_id = (CASE WHEN t.client_a_id = ANY($1::uuid[]) THEN t.client_b_id ELSE t.client_a_id END)) AS blocked_by_me,
                EXISTS (SELECT 1 FROM client_dm_mutes m
                         WHERE m.muter_client_id = (CASE WHEN t.client_a_id = ANY($1::uuid[]) THEN t.client_a_id ELSE t.client_b_id END)
                           AND m.muted_client_id = (CASE WHEN t.client_a_id = ANY($1::uuid[]) THEN t.client_b_id ELSE t.client_a_id END)) AS muted_by_me
           FROM client_dm_threads t
           JOIN clients ca ON ca.id = t.client_a_id
           JOIN clients cb ON cb.id = t.client_b_id
          WHERE (t.client_a_id = ANY($1::uuid[]) AND t.archived_a = FALSE)
             OR (t.client_b_id = ANY($1::uuid[]) AND t.archived_b = FALSE)
          ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
          LIMIT 500`,
        [clientIds],
      );
      return ok(res, {
        dms: r.rows.map((row) => serializeDmThread(row, row.my_client_id)),
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const recipientClientId = String(body.recipientClientId || '').trim();
      if (!recipientClientId) return badRequest(res, 'recipientClientId is required');

      // Find a my-side client_id that shares a group with recipient.
      // Iterate each of my clients-rows because I might own clients-rows
      // in multiple workspaces - only the one that shares a group is
      // valid. The first match wins.
      let workspaceId = null;
      let myClientId = null;
      for (const cid of clientIds) {
        const w = await sharedGroupWorkspace({ clientAId: cid, clientBId: recipientClientId });
        if (w) { workspaceId = w; myClientId = cid; break; }
      }
      if (!workspaceId) {
        return badRequest(res, "You can only DM people you're in a group with.");
      }

      const thread = await getOrCreateDmThread({
        workspaceId, clientAId: myClientId, clientBId: recipientClientId,
      });
      // Hydrate the response with the other side's name. Scope the lookup to
      // the shared workspace (defense-in-depth) so this can only ever return a
      // person in the workspace the group-membership gate just authorized.
      const other = (await sql`
        SELECT name, email FROM clients WHERE id = ${recipientClientId} AND workspace_id = ${workspaceId} LIMIT 1
      `).rows[0];
      return created(res, {
        dm: serializeDmThread({
          ...thread,
          other_name: other?.name, other_email: other?.email,
        }, myClientId),
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
