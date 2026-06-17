// POST /api/me/dms/:id/messages/:mid/report
//   body: { reason? }
//
// Flags a DM message as reported (reported_at + reported_by_client_id) AND
// posts into the reporter's support_thread with kind='report' so Ivy OS
// admin sees it in their support inbox tagged as a report. The
// support_messages row carries metadata (offending text snippet, the
// other client's name, the DM thread id) so admin can act without
// hitting any other endpoint.
import { sql } from '../../../../../_lib/db.js';
import { requireUser } from '../../../../../_lib/auth.js';
import { myClientIds } from '../../../../../_lib/clientPortal.js';
import { requireSameOrigin } from '../../../../../_lib/security.js';
import { readBody } from '../../../../../_lib/body.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../../../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const memberships = await myClientIds(user);
    const clientIds = memberships.map((m) => m.clientId);
    if (clientIds.length === 0) return notFound(res, 'Message not found');
    const { id: threadId, mid } = req.query;

    // Verify the DM thread is mine + load the offending message.
    const r = await sql.query(
      `SELECT msg.id AS msg_id, msg.text, msg.sender_client_id, msg.workspace_id,
              t.id AS thread_id,
              CASE WHEN t.client_a_id = ANY($3::uuid[]) THEN t.client_a_id ELSE t.client_b_id END AS my_client_id,
              c.name AS sender_name
         FROM client_dm_messages msg
         JOIN client_dm_threads t ON t.id = msg.thread_id AND t.workspace_id = msg.workspace_id
         JOIN clients c ON c.id = msg.sender_client_id
        WHERE msg.id = $1 AND msg.thread_id = $2
          AND (t.client_a_id = ANY($3::uuid[]) OR t.client_b_id = ANY($3::uuid[]))
        LIMIT 1`,
      [mid, threadId, clientIds],
    );
    const row = r.rows[0];
    if (!row) return notFound(res, 'Message not found');
    // A user reporting their OWN message is meaningless.
    if (row.sender_client_id === row.my_client_id) {
      return badRequest(res, "You can't report your own message");
    }

    const body = await readBody(req);
    const reason = String(body.reason || '').slice(0, 1000).trim();
    const snippet = String(row.text || '').slice(0, 300);

    // Mark the message reported (only the first reporter wins — the
    // reported_at clause stays null-aware so a re-report from another
    // client still creates a new support entry but doesn't overwrite
    // the original reporter).
    await sql`
      UPDATE client_dm_messages
         SET reported_at = COALESCE(reported_at, NOW()),
             reported_by_client_id = COALESCE(reported_by_client_id, ${row.my_client_id})
       WHERE id = ${mid}
    `;

    // Find or create the reporter's support thread, then post a
    // 'report' message. support_threads is keyed by user_id (one thread
    // per user) — UPSERT for safety.
    const st = await sql`
      INSERT INTO support_threads (user_id, status, last_message_at, last_message_preview)
      VALUES (${user.id}, 'open', NOW(), ${'Reported a DM'})
      ON CONFLICT (user_id) DO UPDATE
        SET status = 'open', last_message_at = NOW(),
            last_message_preview = ${'Reported a DM'},
            unread_admin = support_threads.unread_admin + 1,
            updated_at = NOW()
      RETURNING id
    `;
    const reportText = reason
      ? `[REPORT] ${reason}\n\n— Reported message —\n"${snippet}"`
      : `[REPORT] User reported a direct message.\n\n— Reported message —\n"${snippet}"`;
    await sql`
      INSERT INTO support_messages (thread_id, sender, text, kind, meta)
      VALUES (${st.rows[0].id}, 'user', ${reportText}, 'report',
              ${JSON.stringify({
                reportedMessageId: mid,
                reportedClientName: row.sender_name,
                reportedClientId: row.sender_client_id,
                dmThreadId: threadId,
                workspaceId: row.workspace_id,
                snippet,
              })}::jsonb)
    `;
    return ok(res, { reported: true });
  } catch (err) {
    return serverError(res, err);
  }
}
