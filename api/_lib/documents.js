// Shared serializers + helpers for documents.
import { sql } from './db.js';

export const VALID_KINDS  = new Set(['written', 'pdf']);
export const VALID_STATUS = new Set(['draft', 'sent', 'completed', 'voided', 'declined']);
export const VALID_FIELD_TYPES = new Set(['signature', 'date', 'text', 'initial']);

export function serializeDoc(row, signers = []) {
  if (!row) return null;
  return {
    id:                  row.id,
    name:                row.name,
    kind:                row.kind,
    contentHtml:         row.content_html,
    fileUrl:             row.file_url,
    pdfBlobPathname:     row.pdf_blob_pathname || null,
    finalPdfUrl:         row.final_pdf_url || null,
    pageCount:           row.page_count,
    fields:              row.fields || [],
    recipientClientId:   row.recipient_client_id,
    recipientName:       row.recipient_name,
    recipientEmail:      row.recipient_email,
    status:              row.status,
    sentAt:              row.sent_at,
    completedAt:         row.completed_at,
    declinedAt:          row.declined_at || null,
    declineReason:       row.decline_reason || null,
    completionHash:      row.completion_hash || null,
    signers:             signers.map(serializeSigner),
    activity:            row.activity || [],
    isTemplate:          !!row.is_template,
    templateId:          row.template_id || null,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
  };
}

export function serializeSigner(row) {
  if (!row) return null;
  return {
    id:            row.id,
    orderIndex:    row.order_index,
    clientId:      row.client_id,
    name:          row.name,
    email:         row.email,
    status:        row.status,
    signedAt:      row.signed_at || null,
    declinedAt:    row.declined_at || null,
    declineReason: row.decline_reason || null,
    ip:            row.ip || null,
    userAgent:     row.user_agent || null,
  };
}

// Pulls every signer for a document, ordered. Owner-side serializer
// helper so listing pages can show "2 of 4 signed" without extra
// round trips per row.
export async function fetchSigners(documentId) {
  if (!documentId) return [];
  const { rows } = await sql`
    SELECT id, order_index, client_id, name, email, status,
           signed_at, declined_at, decline_reason, ip, user_agent
      FROM document_signers
     WHERE document_id = ${documentId}
     ORDER BY order_index ASC
  `;
  return rows;
}

// Bulk fetch — given a list of doc ids, returns a Map<docId, signers[]>.
// Used by the index list endpoint to avoid N+1 queries.
export async function fetchSignersBulk(docIds) {
  if (!Array.isArray(docIds) || docIds.length === 0) return new Map();
  const { rows } = await sql.query(
    `SELECT id, document_id, order_index, client_id, name, email, status,
            signed_at, declined_at, decline_reason, ip, user_agent
       FROM document_signers
      WHERE document_id = ANY($1)
      ORDER BY document_id, order_index ASC`,
    [docIds],
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.document_id)) out.set(r.document_id, []);
    out.get(r.document_id).push(r);
  }
  return out;
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
    finalPdfUrl:  row.final_pdf_url || null,
    pageCount:    row.page_count,
    fields:       row.fields || [],
    recipientName: row.recipient_name,
    status:       row.status,
    completedAt:  row.completed_at,
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
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
    // x/y/w/h are 0..1 fractions of the rendered page (top-left origin).
    // signerIndex maps a field to a specific signer (0-based). Default
    // 0 = first signer fills it, matching the legacy single-signer
    // behavior. Out-of-range indexes get clamped on read.
    const x = typeof f.x === 'number' ? clamp01(f.x) : null;
    const y = typeof f.y === 'number' ? clamp01(f.y) : null;
    const w = typeof f.w === 'number' ? clamp01(f.w) : null;
    const h = typeof f.h === 'number' ? clamp01(f.h) : null;
    out.push({
      id:    f.id || `f${i}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      label: (f.label || '').toString().slice(0, 120),
      required: f.required !== false,  // default to required
      value: typeof f.value === 'string' ? f.value : '',
      page:  Number.isInteger(f.page) ? Math.max(0, f.page) : 0,
      signerIndex: Number.isInteger(f.signerIndex) ? Math.max(0, f.signerIndex) : 0,
      x, y, w, h,
    });
  }
  return out;
}
