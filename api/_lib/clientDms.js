// Shared helpers for client↔client DMs. Mirrors the cohort group_chat
// helpers but with stricter permission gating - owners never see these
// threads; access is controlled by "do these two clients share an
// active group_thread_members row in the same workspace?"
import { sql } from './db.js';
import { notifyClientSafe } from './push.js';

// Pair-canonicalize: always (smaller_uuid, larger_uuid) so (a,b) and
// (b,a) collapse to the same thread row. Returns [a, b].
export function orderPair(x, y) {
  return String(x) < String(y) ? [x, y] : [y, x];
}

// Verifies the two clients share at least one active group_thread_members
// row in the SAME workspace. Returns the workspace_id on success, null
// otherwise. Used as the permission gate before creating a DM thread or
// re-sending into one (a recipient who's left every shared group can no
// longer receive DMs from this sender).
export async function sharedGroupWorkspace({ clientAId, clientBId }) {
  if (!clientAId || !clientBId || clientAId === clientBId) return null;
  const { rows } = await sql`
    SELECT a.workspace_id
      FROM group_thread_members a
      JOIN group_thread_members b
        ON a.thread_id = b.thread_id
       AND a.workspace_id = b.workspace_id
     WHERE a.client_id = ${clientAId}
       AND b.client_id = ${clientBId}
       AND a.left_at IS NULL
       AND b.left_at IS NULL
     LIMIT 1
  `;
  return rows[0]?.workspace_id || null;
}

// Find-or-create a DM thread between two clients in a workspace.
// Caller has already established a shared-group permission.
export async function getOrCreateDmThread({ workspaceId, clientAId, clientBId }) {
  const [a, b] = orderPair(clientAId, clientBId);
  const existing = await sql`
    SELECT * FROM client_dm_threads
     WHERE workspace_id = ${workspaceId} AND client_a_id = ${a} AND client_b_id = ${b}
     LIMIT 1
  `;
  if (existing.rows.length > 0) return existing.rows[0];
  const ins = await sql`
    INSERT INTO client_dm_threads (workspace_id, client_a_id, client_b_id)
    VALUES (${workspaceId}, ${a}, ${b})
    ON CONFLICT (workspace_id, client_a_id, client_b_id) DO UPDATE
      SET created_at = client_dm_threads.created_at
    RETURNING *
  `;
  return ins.rows[0];
}

// Is `senderClientId` blocked by `recipientClientId`? Used to silently
// drop sends from a blocked client (we return success so they can't
// probe for the block existence, but the message never reaches the
// recipient's thread fetch - the blocker sees nothing from blocked).
//
// Implementation choice: HARD reject the send instead of silent-drop.
// Probing concern is minor (the recipient's UI showing "blocked" pill
// is far more useful for moderation), and silent-drop has a habit of
// shipping bugs where users wonder why their messages stop landing.
export async function isBlocked({ blockerClientId, blockedClientId }) {
  if (!blockerClientId || !blockedClientId) return false;
  const r = await sql`
    SELECT 1 FROM client_dm_blocks
     WHERE blocker_client_id = ${blockerClientId}
       AND blocked_client_id = ${blockedClientId}
     LIMIT 1
  `;
  return r.rows.length > 0;
}

// Is `senderClientId` muted by `muterClientId`? Used to skip push.
export async function isMuted({ muterClientId, mutedClientId }) {
  if (!muterClientId || !mutedClientId) return false;
  const r = await sql`
    SELECT 1 FROM client_dm_mutes
     WHERE muter_client_id = ${muterClientId}
       AND muted_client_id = ${mutedClientId}
     LIMIT 1
  `;
  return r.rows.length > 0;
}

export function serializeDmThread(row, myClientId) {
  if (!row) return null;
  const meIsA = row.client_a_id === myClientId;
  return {
    id:                row.id,
    otherClientId:     meIsA ? row.client_b_id : row.client_a_id,
    otherClientName:   row.other_name || null,
    otherClientEmail:  row.other_email || null,
    lastMessageAt:     row.last_message_at,
    lastPreview:       row.last_message_preview || '',
    unread:            meIsA ? Number(row.unread_a || 0) : Number(row.unread_b || 0),
    archived:          meIsA ? !!row.archived_a : !!row.archived_b,
    blockedByMe:       !!row.blocked_by_me,
    mutedByMe:         !!row.muted_by_me,
    createdAt:         row.created_at,
  };
}

export function serializeDmMessage(row, myClientId) {
  if (!row) return null;
  return {
    id:               row.id,
    threadId:         row.thread_id,
    senderClientId:   row.sender_client_id,
    text:             row.text,
    attachments:      row.attachments || [],
    parentMessageId:  row.parent_message_id || null,
    mine:             row.sender_client_id === myClientId,
    reportedAt:       row.reported_at,
    createdAt:        row.created_at,
  };
}

// Per-message side effects: bump recipient's unread, set thread last_*,
// fire push (unless recipient muted the sender).
export async function fanoutDmMessage({
  workspaceId, thread, senderClientId, preview,
  recipientClientId, recipientUserId,
}) {
  const senderIsA = thread.client_a_id === senderClientId;
  // Increment the OTHER side's unread.
  const colUnread = senderIsA ? 'unread_b' : 'unread_a';
  const colArchive = senderIsA ? 'archived_b' : 'archived_a';
  // Sending un-archives the recipient's side so a re-engagement
  // resurfaces the thread in their list.
  await sql.query(
    `UPDATE client_dm_threads
        SET ${colUnread} = ${colUnread} + 1,
            ${colArchive} = FALSE,
            last_message_at = NOW(),
            last_message_preview = $1
      WHERE id = $2 AND workspace_id = $3`,
    [preview, thread.id, workspaceId],
  );

  // Skip push if recipient muted the sender.
  const muted = await isMuted({ muterClientId: recipientClientId, mutedClientId: senderClientId });
  if (!muted) {
    notifyClientSafe({
      clientId: recipientClientId,
      type: 'messages',
      payload: {
        title: 'New direct message',
        body: preview,
        url: `/me/messages?dm=${thread.id}`,
        tag: `dm-${thread.id}`,
      },
    });
  }
}
