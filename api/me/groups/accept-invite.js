// POST /api/me/groups/accept-invite  body: { token }
//
// Looks up the (un-revoked, un-expired, under-quota) invite token.
// Resolves the calling user → clients-row in the invite's workspace
// (or creates one keyed to their verified email). Inserts a
// group_thread_members row. Returns { groupId, threadName }.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { readBody } from '../../_lib/body.js';
import { hashInviteToken } from '../../_lib/groupChat.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const plaintext = String(body.token || '').trim();
    if (!plaintext) return badRequest(res, 'token required');
    const hash = hashInviteToken(plaintext);

    const t = await sql`
      SELECT id, thread_id, workspace_id, max_uses, used_count, expires_at, revoked_at
        FROM group_invite_tokens
       WHERE token_hash = ${hash} LIMIT 1
    `;
    const invite = t.rows[0];
    if (!invite) return badRequest(res, 'Invalid invite');
    if (invite.revoked_at) return badRequest(res, 'This invite was revoked');
    if (invite.expires_at && new Date(invite.expires_at) <= new Date()) {
      return badRequest(res, 'This invite has expired');
    }
    if (invite.used_count >= invite.max_uses) {
      return badRequest(res, 'This invite is fully claimed');
    }

    // Resolve the user → clients-row in the invite's workspace. Prefer
    // an existing row (matched by user_id, then by email if verified).
    // Email match requires verified email - same SECURITY rule as
    // myClientIds - so a stranger can't claim invites against someone
    // else's known email.
    let client = (await sql`
      SELECT id FROM clients
       WHERE workspace_id = ${invite.workspace_id} AND user_id = ${user.id}
       LIMIT 1
    `).rows[0];
    if (!client && user.email && user.email_verified_at) {
      client = (await sql`
        SELECT id FROM clients
         WHERE workspace_id = ${invite.workspace_id}
           AND email = ${user.email.toLowerCase()}
         LIMIT 1
      `).rows[0];
    }
    if (!client) {
      const ins = await sql`
        INSERT INTO clients (workspace_id, name, email, stage, source, user_id)
        VALUES (${invite.workspace_id},
                ${user.name || user.email},
                ${user.email?.toLowerCase()},
                'active', 'group_invite', ${user.id})
        RETURNING id
      `;
      client = ins.rows[0];
    }

    // Already an active member? This is an idempotent re-click — don't burn a
    // use (the old code incremented used_count on every click).
    const alreadyMember = (await sql`
      SELECT 1 FROM group_thread_members
       WHERE thread_id = ${invite.thread_id} AND client_id = ${client.id}
         AND left_at IS NULL
       LIMIT 1
    `).rows[0];

    if (!alreadyMember) {
      // Atomically CLAIM one use BEFORE adding the member, so two concurrent
      // redeems of a max_uses=1 invite can't both succeed (the previous
      // read-then-write let both pass the quota check and both be added).
      const claim = await sql`
        UPDATE group_invite_tokens SET used_count = used_count + 1
         WHERE id = ${invite.id} AND used_count < max_uses
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())
        RETURNING id
      `;
      if (claim.rows.length === 0) return badRequest(res, 'This invite is fully claimed');
    }

    // Add to the group (idempotent for a rejoin).
    await sql`
      INSERT INTO group_thread_members (thread_id, client_id, workspace_id)
      VALUES (${invite.thread_id}, ${client.id}, ${invite.workspace_id})
      ON CONFLICT (thread_id, client_id) DO UPDATE
        SET left_at = NULL,
            unread_count = 0
    `;
    await sql`
      INSERT INTO group_messages (thread_id, workspace_id, sender, kind, text)
      VALUES (${invite.thread_id}, ${invite.workspace_id}, 'system', 'invite_accepted',
              ${`${user.name || user.email} joined via invite link.`})
    `;
    const thr = await sql`SELECT name FROM group_threads WHERE id = ${invite.thread_id} LIMIT 1`;
    return ok(res, { groupId: invite.thread_id, threadName: thr.rows[0]?.name || null });
  } catch (err) {
    return serverError(res, err);
  }
}
