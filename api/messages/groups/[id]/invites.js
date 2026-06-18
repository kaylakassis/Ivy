// /api/messages/groups/:id/invites
//   GET  → list active invite tokens (without exposing plaintext)
//   POST → mint a new token { maxUses?, expiresInHours? }
//          Returns the plaintext token EXACTLY ONCE.
// DELETE /api/messages/groups/:id/invites?tokenId=… → revoke
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { readBody } from '../../../_lib/body.js';
import { fetchOwnedGroup, mintInviteToken } from '../../../_lib/groupChat.js';
import { appUrl } from '../../../_lib/tokens.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;
    const thread = await fetchOwnedGroup({ id, workspaceId });
    if (!thread) return notFound(res, 'Group not found');

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT id, max_uses, used_count, expires_at, created_at, revoked_at
          FROM group_invite_tokens
         WHERE thread_id = ${id} AND workspace_id = ${workspaceId}
         ORDER BY created_at DESC LIMIT 50
      `;
      return ok(res, { invites: rows.map((r) => ({
        id: r.id, maxUses: r.max_uses, usedCount: r.used_count,
        expiresAt: r.expires_at, createdAt: r.created_at,
        revokedAt: r.revoked_at,
        active: !r.revoked_at && (!r.expires_at || new Date(r.expires_at) > new Date())
                && r.used_count < r.max_uses,
      })) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const maxUses = Math.max(1, Math.min(1000, Number.parseInt(body.maxUses, 10) || 50));
      const expiresInHours = Number.parseInt(body.expiresInHours, 10);
      const expiresAt = Number.isFinite(expiresInHours) && expiresInHours > 0
        ? new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString()
        : null;

      const { plaintext, hash } = mintInviteToken();
      const ins = await sql`
        INSERT INTO group_invite_tokens (thread_id, workspace_id, token_hash,
                                          max_uses, expires_at, created_by_user_id)
        VALUES (${id}, ${workspaceId}, ${hash}, ${maxUses}, ${expiresAt}, ${user.id})
        RETURNING id, max_uses, expires_at, created_at
      `;
      const row = ins.rows[0];
      return ok(res, {
        invite: {
          id: row.id,
          maxUses: row.max_uses,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          // Returned ONCE - caller must surface in UI immediately.
          url: `${appUrl()}/invite/group/${plaintext}`,
          token: plaintext,
        },
      });
    }

    if (req.method === 'DELETE') {
      const tokenId = String(req.query.tokenId || '').trim();
      if (!tokenId) return badRequest(res, 'tokenId required');
      await sql`
        UPDATE group_invite_tokens SET revoked_at = NOW()
         WHERE id = ${tokenId} AND thread_id = ${id} AND workspace_id = ${workspaceId}
      `;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
