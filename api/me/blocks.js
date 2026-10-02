// /api/me/blocks - businesses this client has blocked.
//   GET                   → { blocks: [{ workspaceId, businessName, createdAt }] }
//   POST   { workspaceId } → block that business (idempotent)
//   DELETE { workspaceId } → unblock
//
// The workspace must be one the user has a client row in (resolved via
// myClientIds, never trusted from the body). A block stops messages in
// both directions; the client can undo it any time from their profile.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds } from '../_lib/clientPortal.js';
import { listClientBlocks } from '../_lib/moderation.js';
import { badRequest, methodNotAllowed, noContent, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      return ok(res, { blocks: await listClientBlocks(user.id) });
    }

    if (req.method === 'POST' || req.method === 'DELETE') {
      const body = await readBody(req);
      const workspaceId = body.workspaceId ? String(body.workspaceId) : null;
      if (!workspaceId) return badRequest(res, 'workspaceId is required');
      const memberships = await myClientIds(user);
      const m = memberships.find((x) => x.workspaceId === workspaceId);
      if (!m) return badRequest(res, 'You are not a client of that business');

      if (req.method === 'POST') {
        await sql`
          INSERT INTO contact_blocks (workspace_id, client_id, direction, created_by_user_id)
          VALUES (${workspaceId}, ${m.clientId}, 'client_blocks_business', ${user.id})
          ON CONFLICT (workspace_id, client_id, direction) DO NOTHING
        `;
        return ok(res, { blocked: true, workspaceId });
      }

      await sql`
        DELETE FROM contact_blocks
         WHERE workspace_id = ${workspaceId} AND client_id = ${m.clientId}
           AND direction = 'client_blocks_business'
      `;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
