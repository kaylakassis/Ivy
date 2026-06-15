// /api/messages/groups
//   GET  → list this workspace's group threads (active + archived flag)
//   POST → create { name, description, mode, clientIds[] }
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { serializeGroupThread } from '../../_lib/groupChat.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

const VALID_MODES = new Set(['open', 'broadcast']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (req.method === 'GET') {
      const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
      const { rows } = await sql`
        SELECT t.*,
               (SELECT COUNT(*)::int FROM group_thread_members m
                 WHERE m.thread_id = t.id AND m.workspace_id = ${workspaceId} AND m.left_at IS NULL) AS member_count
          FROM group_threads t
         WHERE t.workspace_id = ${workspaceId}
           AND (${includeArchived} OR t.archived = FALSE)
         ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
         LIMIT 500
      `;
      return ok(res, {
        groups: rows.map((r) => serializeGroupThread(r, { memberCount: r.member_count })),
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const description = body.description ? String(body.description).slice(0, 4000) : null;
      const mode = String(body.mode || 'open');
      const clientIds = Array.isArray(body.clientIds)
        ? body.clientIds.filter((x) => typeof x === 'string').slice(0, 500)
        : [];
      if (!name)                  return badRequest(res, 'name is required');
      if (name.length > 200)      return badRequest(res, 'name is too long');
      if (!VALID_MODES.has(mode)) return badRequest(res, 'mode must be "open" or "broadcast"');

      // Workspace-scope every clientId. Drop any that don't belong —
      // never throw, so a stale UI-cached id can't block the whole
      // create.
      let validClientIds = [];
      if (clientIds.length > 0) {
        const r = await sql.query(
          `SELECT id FROM clients WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
          [workspaceId, clientIds],
        );
        validClientIds = r.rows.map((row) => row.id);
      }

      const ins = await sql`
        INSERT INTO group_threads (workspace_id, name, description, mode)
        VALUES (${workspaceId}, ${name}, ${description}, ${mode})
        RETURNING *
      `;
      const thread = ins.rows[0];

      if (validClientIds.length > 0) {
        // Bulk insert members. ON CONFLICT covers the (extremely
        // unlikely) race where someone POSTs the same payload twice.
        const values = validClientIds.map((cid, i) => `($1, $${i + 2}, $1)`).join(', ');
        // params: $1 = workspace_id (and thread_id is index 0 — actually
        // we need thread_id too). Reshape:
        await sql.query(
          `INSERT INTO group_thread_members (thread_id, client_id, workspace_id)
              SELECT $1, c, $2 FROM unnest($3::uuid[]) AS c
            ON CONFLICT (thread_id, client_id) DO NOTHING`,
          [thread.id, workspaceId, validClientIds],
        );
        // System message announcing the create.
        await sql`
          INSERT INTO group_messages (thread_id, workspace_id, sender, kind, text)
          VALUES (${thread.id}, ${workspaceId}, 'system', 'created',
                  ${`Group created with ${validClientIds.length} member${validClientIds.length === 1 ? '' : 's'}.`})
        `;
        // Reference unused-suppression for the earlier values builder.
        void values;
      }

      return created(res, {
        group: serializeGroupThread(thread, { memberCount: validClientIds.length }),
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
