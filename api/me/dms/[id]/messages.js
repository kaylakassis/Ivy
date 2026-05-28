// POST /api/me/dms/:id/messages — send a DM
// Rejected when:
//   • the two clients no longer share an active group
//   • the recipient has blocked the sender (HARD reject — see clientDms.js note)
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { myClientIds } from '../../../_lib/clientPortal.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { readBody } from '../../../_lib/body.js';
import { withIdempotency } from '../../../_lib/idempotency.js';
import {
  sharedGroupWorkspace, isBlocked, fanoutDmMessage, serializeDmMessage,
} from '../../../_lib/clientDms.js';
import { cleanAttachments, previewFor } from '../../../_lib/groupChat.js';
import { methodNotAllowed, notFound, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) return notFound(res, 'DM not found');
    const { id } = req.query;

    const r = await sql.query(
      `SELECT t.*,
              CASE WHEN t.client_a_id = ANY($2::uuid[]) THEN t.client_a_id ELSE t.client_b_id END AS my_client_id,
              CASE WHEN t.client_a_id = ANY($2::uuid[]) THEN t.client_b_id ELSE t.client_a_id END AS other_client_id
         FROM client_dm_threads t
        WHERE t.id = $1
          AND (t.client_a_id = ANY($2::uuid[]) OR t.client_b_id = ANY($2::uuid[]))
        LIMIT 1`,
      [id, clientIds],
    );
    const thread = r.rows[0];
    if (!thread) return notFound(res, 'DM not found');

    const idemp = await withIdempotency(req, user.id, async () => {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const attachments = cleanAttachments(body.attachments);
      const parentMessageId = body.parentMessageId ? String(body.parentMessageId) : null;
      if (!text && attachments.length === 0) {
        return { status: 400, body: { error: 'Message text or attachment is required' } };
      }
      if (text.length > 4000) return { status: 400, body: { error: 'Message is too long' } };

      // Re-check shared-group permission at send time — a client who's
      // left every shared group should no longer be able to message.
      const stillShared = await sharedGroupWorkspace({
        clientAId: thread.my_client_id, clientBId: thread.other_client_id,
      });
      if (!stillShared) {
        return { status: 403, body: { error: "You're no longer in a group with this member." } };
      }

      // Recipient block check — hard reject so the sender knows.
      const blocked = await isBlocked({
        blockerClientId: thread.other_client_id,
        blockedClientId: thread.my_client_id,
      });
      if (blocked) {
        return { status: 403, body: { error: "This member isn't accepting messages from you." } };
      }

      if (parentMessageId) {
        const p = await sql`
          SELECT id FROM client_dm_messages
           WHERE id = ${parentMessageId} AND thread_id = ${id} AND workspace_id = ${thread.workspace_id}
           LIMIT 1
        `;
        if (p.rows.length === 0) {
          return { status: 400, body: { error: 'Parent message not found' } };
        }
      }

      const inserted = await sql`
        INSERT INTO client_dm_messages (thread_id, workspace_id, sender_client_id,
                                         text, attachments, parent_message_id)
        VALUES (${id}, ${thread.workspace_id}, ${thread.my_client_id},
                ${text}, ${JSON.stringify(attachments)}::jsonb, ${parentMessageId || null})
        RETURNING *
      `;
      await fanoutDmMessage({
        workspaceId: thread.workspace_id, thread,
        senderClientId: thread.my_client_id,
        preview: previewFor({ text, attachments }),
        recipientClientId: thread.other_client_id,
      });
      return {
        status: 201,
        body: { message: serializeDmMessage(inserted.rows[0], thread.my_client_id) },
      };
    });
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);
  } catch (err) {
    return serverError(res, err);
  }
}
