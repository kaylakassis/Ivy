// Shared serializers + ownership helpers for the group_chat tables.
// Parallel to api/_lib/messages.js (1:1 threads) — the two systems
// do not share rows.
import { sql } from './db.js';
import { notifyClientSafe, notifyOwnerSafe } from './push.js';

export function serializeGroupThread(row, { memberCount, currentMember } = {}) {
  if (!row) return null;
  return {
    id:                row.id,
    name:              row.name,
    description:       row.description || '',
    mode:              row.mode,
    archived:          !!row.archived,
    unreadBiz:         Number(row.unread_biz || 0),
    lastMessageAt:     row.last_message_at,
    lastPreview:       row.last_message_preview || '',
    memberCount:       Number.isFinite(memberCount) ? memberCount : null,
    // For client-portal responses: this client's own member-row state.
    unreadClient:      currentMember ? Number(currentMember.unread_count || 0) : null,
    muted:             currentMember ? !!currentMember.muted : null,
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
  };
}

export function serializeGroupMember(row) {
  if (!row) return null;
  return {
    clientId:    row.client_id,
    clientName:  row.client_name || null,
    clientEmail: row.client_email || null,
    joinedAt:    row.joined_at,
    leftAt:      row.left_at,
    muted:       !!row.muted,
  };
}

export function serializeGroupMessage(row) {
  if (!row) return null;
  return {
    id:             row.id,
    threadId:       row.thread_id,
    sender:         row.sender,
    senderClientId: row.sender_client_id || null,
    senderName:     row.sender_name || null,    // joined client name when sender='client'
    text:           row.text,
    attachments:    row.attachments || [],
    kind:           row.kind,
    meta:           row.meta || {},
    createdAt:      row.created_at,
  };
}

// Verify the named group_thread belongs to this workspace + return
// the row. Returns null on miss.
export async function fetchOwnedGroup({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`
    SELECT * FROM group_threads
     WHERE id = ${id} AND workspace_id = ${workspaceId}
     LIMIT 1
  `;
  return rows[0] || null;
}

// Verify this client is an ACTIVE member of the named group_thread in
// the named workspace. Returns the member row + thread row, or null
// if either is missing or the client has left. Used by every /api/me/groups/*
// endpoint to gate before reads/writes.
export async function fetchClientGroupMembership({ threadId, clientId, workspaceId }) {
  if (!threadId || !clientId || !workspaceId) return null;
  const { rows } = await sql`
    SELECT t.id AS thread_id, t.name, t.description, t.mode, t.archived,
           t.last_message_at, t.last_message_preview, t.created_at, t.updated_at,
           m.client_id, m.joined_at, m.left_at, m.unread_count, m.last_read_at, m.muted
      FROM group_thread_members m
      JOIN group_threads t
        ON t.id = m.thread_id AND t.workspace_id = m.workspace_id
     WHERE m.thread_id = ${threadId}
       AND m.client_id = ${clientId}
       AND m.workspace_id = ${workspaceId}
       AND m.left_at IS NULL
     LIMIT 1
  `;
  return rows[0] || null;
}

// Per-message side-effects: bump unread for every member who didn't
// send, push to them, push to the owner (if a client sent), update
// thread last_* fields. Best-effort — caller already returned the
// new message to the user; this is fire-and-forget but awaited so
// Vercel doesn't kill it.
//
// senderClientId = null when sender is the owner.
export async function fanoutGroupMessage({
  workspaceId, threadId, threadName, senderClientId, preview,
}) {
  // Bump unread for every active member who isn't the sender + isn't
  // muted. One UPDATE, atomic.
  await sql`
    UPDATE group_thread_members
       SET unread_count = unread_count + 1
     WHERE thread_id = ${threadId}
       AND workspace_id = ${workspaceId}
       AND left_at IS NULL
       AND muted = FALSE
       AND (${senderClientId}::uuid IS NULL OR client_id <> ${senderClientId}::uuid)
  `;

  // Bump biz-side unread only when a client sent (owner already saw
  // their own send).
  if (senderClientId) {
    await sql`
      UPDATE group_threads
         SET unread_biz = unread_biz + 1,
             last_message_at = NOW(),
             last_message_preview = ${preview},
             updated_at = NOW()
       WHERE id = ${threadId} AND workspace_id = ${workspaceId}
    `;
  } else {
    await sql`
      UPDATE group_threads
         SET last_message_at = NOW(),
             last_message_preview = ${preview},
             updated_at = NOW()
       WHERE id = ${threadId} AND workspace_id = ${workspaceId}
    `;
  }

  // Push to every active, unmuted member who isn't the sender.
  const recipients = await sql`
    SELECT client_id FROM group_thread_members
     WHERE thread_id = ${threadId}
       AND workspace_id = ${workspaceId}
       AND left_at IS NULL
       AND muted = FALSE
       AND (${senderClientId}::uuid IS NULL OR client_id <> ${senderClientId}::uuid)
  `;
  for (const r of recipients.rows) {
    notifyClientSafe({
      clientId: r.client_id,
      type: 'messages',
      payload: {
        title: threadName ? `Group · ${threadName}` : 'New group message',
        body: preview,
        url: `/me/messages?group=${threadId}`,
        tag: `group-${threadId}`,
      },
    });
  }

  // If a client sent, ping the owner too.
  if (senderClientId) {
    notifyOwnerSafe({
      workspaceId, type: 'messages',
      payload: {
        title: threadName ? `Group · ${threadName}` : 'New group message',
        body: preview,
        url: `/messages?group=${threadId}`,
        tag: `group-${threadId}`,
      },
    });
  }
}

// Compute a sensible preview from text + attachments. Voice memos
// surface as 🎙️ Voice message, file-only as Attachment.
export function previewFor({ text, attachments }) {
  if (text && text.trim()) return text.trim().slice(0, 200);
  const audioOnly = (attachments || []).some((a) => String(a?.type || '').startsWith('audio/'));
  if (audioOnly) return '🎙️ Voice message';
  if ((attachments || []).length > 0) return 'Attachment';
  return '';
}

// Sanitize the attachments payload — same shape as messages POST.
export function cleanAttachments(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((a) => ({
      url:        String(a?.url || '').slice(0, 1000),
      type:       String(a?.type || '').slice(0, 80),
      name:       a?.name ? String(a.name).slice(0, 200) : null,
      durationMs: Number.isFinite(Number(a?.durationMs)) ? Number(a.durationMs) : null,
    }))
    .filter((a) => a.url && a.type);
}
