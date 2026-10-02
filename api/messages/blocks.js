// /api/messages/blocks - the business's blocked clients.
//   GET            → { blocks: [{ clientId, clientName, clientEmail, createdAt, reason }] }
//   POST   { clientId, reason? } → block (idempotent)
//   DELETE { clientId }          → unblock
//
// Workspace-scoped: the client must belong to this workspace. A block
// stops messages in both directions (see api/_lib/moderation.js); the
// owner can undo it any time from Account → Blocked.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { listOwnerBlocks } from '../_lib/moderation.js';
import { badRequest, methodNotAllowed, noContent, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      return ok(res, { blocks: await listOwnerBlocks(workspaceId) });
    }

    if (req.method === 'POST' || req.method === 'DELETE') {
      const body = await readBody(req);
      const clientId = body.clientId ? String(body.clientId) : null;
      if (!clientId) return badRequest(res, 'clientId is required');
      const cl = await sql`SELECT id FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
      if (cl.rows.length === 0) return badRequest(res, 'Unknown client');

      if (req.method === 'POST') {
        const reason = body.reason == null ? null : String(body.reason).trim().slice(0, 500) || null;
        await sql`
          INSERT INTO contact_blocks (workspace_id, client_id, direction, created_by_user_id, reason)
          VALUES (${workspaceId}, ${clientId}, 'owner_blocks_client', ${user.id}, ${reason})
          ON CONFLICT (workspace_id, client_id, direction) DO NOTHING
        `;
        return ok(res, { blocked: true, clientId });
      }

      await sql`
        DELETE FROM contact_blocks
         WHERE workspace_id = ${workspaceId} AND client_id = ${clientId}
           AND direction = 'owner_blocks_client'
      `;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
