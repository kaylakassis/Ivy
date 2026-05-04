// Shared serializers + helpers for documents.
import { sql } from './db.js';

export const VALID_KINDS  = new Set(['written', 'pdf']);
export const VALID_STATUS = new Set(['draft', 'sent', 'completed', 'voided']);
export const VALID_FIELD_TYPES = new Set(['signature', 'date', 'text', 'initial']);

export function serializeDoc(row) {
  if (!row) return null;
  return {
    id:                  row.id,
    name:                row.name,
    kind:                row.kind,
    contentHtml:         row.content_html,
    fileUrl:             row.file_url,
    pageCount:           row.page_count,
    fields:              row.fields || [],
    recipientClientId:   row.recipient_client_id,
    recipientName:       row.recipient_name,
    recipientEmail:      row.recipient_email,
    status:              row.status,
    sentAt:              row.sent_at,
    completedAt:         row.completed_at,
    activity:            row.activity || [],
    isTemplate:          !!row.is_template,
    templateId:          row.template_id || null,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
  };
}

// Public-facing serializer (no workspace ids, no sign token, no internal flags).
export function serializeDocPublic(row) {
  if (!row) return null;
  return {
    id:           row.id,
    name:         row.name,
    kind:         row.kind,
    contentHtml:  row.content_html,
    fileUrl:      row.file_url,
    pageCount:    row.page_count,
    fields:       row.fields || [],
    recipientName: row.recipient_name,
    status:       row.status,
    completedAt:  row.completed_at,
  };
}

export async function fetchOwnedDoc({ id, workspaceId }) {
  if (!id) return null;
  const { rows } = await sql`
    SELECT * FROM documents WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  return rows[0] || null;
}

// Validate the user-submitted fields list. Returns the cleaned array or
// null if invalid (caller should badRequest).
export function cleanFields(input) {
  if (!Array.isArray(input)) return null;
  if (input.length > 50) return null;
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const f = input[i] || {};
    const type = (f.type || '').toString();
    if (!VALID_FIELD_TYPES.has(type)) return null;
    out.push({
      id:    f.id || `f${i}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      label: (f.label || '').toString().slice(0, 120),
      required: f.required !== false,  // default to required
      value: typeof f.value === 'string' ? f.value : '',
      // x/y/w/h reserved for the drag-drop phase; pass through if provided.
      page:  Number.isInteger(f.page) ? f.page : 0,
      x:     typeof f.x === 'number' ? f.x : null,
      y:     typeof f.y === 'number' ? f.y : null,
      w:     typeof f.w === 'number' ? f.w : null,
      h:     typeof f.h === 'number' ? f.h : null,
    });
  }
  return out;
}
