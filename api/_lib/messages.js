// Shared serializers + helpers for the messages tables.
import { sql } from './db.js';

export function serializeThread(row) {
  if (!row) return null;
  return {
    id:             row.id,
    clientId:       row.client_id,
    clientName:     row.client_name,
    clientEmail:    row.client_email,
    mode:           row.mode,
    unreadBiz:      row.unread_biz,
    unreadClient:   row.unread_client,
    lastMessageAt:  row.last_message_at,
    lastPreview:    row.last_message_preview || '',
    createdAt:      row.created_at,
  };
}

export function serializeMessage(row) {
  if (!row) return null;
  return {
    id:           row.id,
    threadId:     row.thread_id,
    sender:       row.sender,
    text:         row.text,
    attachments:  row.attachments || [],
    kind:         row.kind,
    meta:         row.meta || {},
    createdAt:    row.created_at,
  };
}

// Fetch a thread (with client info) and verify it belongs to the workspace.
export async function fetchOwnedThread({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`
    SELECT t.*, c.name AS client_name, c.email AS client_email
    FROM message_threads t
    JOIN clients c ON c.id = t.client_id AND c.workspace_id = t.workspace_id
    WHERE t.id = ${id} AND t.workspace_id = ${workspaceId}
  `;
  return rows[0] || null;
}
