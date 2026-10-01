// Shared serializers + helpers for documents.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { generateRawToken, appUrl } from './tokens.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { notifyClientSafe } from './push.js';

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
    isOwner:       !!row.is_owner,
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
    SELECT id, order_index, client_id, is_owner, name, email, status,
           signed_at, declined_at, decline_reason, ip, user_agent
      FROM document_signers
     WHERE document_id = ${documentId}
     ORDER BY order_index ASC
  `;
  return rows;
}

// Bulk fetch - given a list of doc ids, returns a Map<docId, signers[]>.
// Used by the index list endpoint to avoid N+1 queries.
export async function fetchSignersBulk(docIds) {
  if (!Array.isArray(docIds) || docIds.length === 0) return new Map();
  const { rows } = await sql.query(
    `SELECT id, document_id, order_index, client_id, is_owner, name, email, status,
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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Send a document for signing. The ONE implementation behind both
// POST /api/documents/send (the Documents UI) and the workflow action
// "Send a document for signing", so an automated send is exactly what
// the owner would get by clicking Send:
//   • wipes prior signer rows, inserts one per recipient in order
//   • mints the FIRST signer's token only (sequential signing - the
//     /api/sign/[token] handler mints the next one on completion)
//   • flips the document to 'sent', blanks stale field values, logs
//     the activity entry, mirrors the first signer onto recipient_*
//   • emails the first signer, drops a system message in their chat
//     thread, pushes to their portal
//
// `recipients` are already resolved: [{ clientId|null, name, email,
// isOwner? }]. Callers validate them (workspace ownership, email
// present). `doc` is the owned documents row (fetchOwnedDoc / RETURNING *).
// Returns { row, signers, link, emailWarning } - the email failing does
// NOT throw: the document is already sent + the token minted, so the
// recovery is the Resend button, and the caller surfaces the warning.
export async function sendDocumentForSigning({ workspaceId, doc, recipients, branding }) {
  if (!workspaceId || !doc?.id) throw new Error('Document is required');
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('At least one recipient is required');
  const id = doc.id;

  // Defense-in-depth: scope by workspace via subquery so a regression in
  // the caller's ownership check can't wipe someone else's signers.
  await sql`
    DELETE FROM document_signers
     WHERE document_id = ${id}
       AND document_id IN (
         SELECT id FROM documents WHERE id = ${id} AND workspace_id = ${workspaceId}
       )
  `;

  const firstRaw  = generateRawToken(32);
  const firstHash = crypto.createHash('sha256').update(firstRaw).digest('hex');

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const isFirst = i === 0;
    // eslint-disable-next-line no-await-in-loop
    await sql`
      INSERT INTO document_signers (
        document_id, order_index, client_id, is_owner, name, email,
        sign_token_hash, status
      ) VALUES (
        ${id}, ${i}, ${r.clientId || null}, ${!!r.isOwner}, ${r.name}, ${r.email},
        ${isFirst ? firstHash : null},
        ${isFirst ? 'awaiting' : 'pending'}
      )
    `;
  }

  const newActivity = [
    ...(doc.activity || []),
    {
      ts: new Date().toISOString(),
      kind: 'sent',
      text: `Sent to ${recipients.length} signer${recipients.length === 1 ? '' : 's'}: ${recipients.map((r) => r.name).join(', ')}`,
    },
  ];

  // Keep the legacy recipient_* fields in sync with the FIRST signer so
  // older code paths still display a reasonable "to whom" label. Blank
  // stale field values from a prior signing round (re-send after
  // void/decline) but keep the field metadata.
  const cleanedFields = (doc.fields || []).map((f) => ({ ...f, value: '' }));
  const first = recipients[0];
  const updated = await sql`
    UPDATE documents SET
      recipient_client_id = ${first.clientId || null},
      recipient_name      = ${first.name},
      recipient_email     = ${first.email},
      status              = 'sent',
      sign_token_hash     = ${firstHash},
      sent_at             = NOW(),
      activity            = ${JSON.stringify(newActivity)}::jsonb,
      fields              = ${JSON.stringify(cleanedFields)}::jsonb,
      completion_hash     = NULL,
      decline_reason      = NULL,
      declined_at         = NULL,
      final_pdf_url       = NULL,
      final_pdf_blob_pathname = NULL,
      updated_at          = NOW()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
    RETURNING *
  `;

  // Email + thread message for the first signer only. Subsequent signers
  // get their email when their turn comes up.
  const link = `${appUrl()}/sign/${encodeURIComponent(firstRaw)}`;
  const positionLine = recipients.length > 1
    ? `<p style="font-size:13px;color:#85827B;">You're signer 1 of ${recipients.length}. The next signer will receive their link after you finish.</p>`
    : '';
  const brand = branding || await fetchBranding(workspaceId).catch(() => ({}));
  let emailWarning = null;
  try {
    await sendEmailToClient({
      clientId: first.clientId || null,
      type: 'documents',
      to: first.email,
      subject: `Action needed: sign "${doc.name}"`,
      replyTo: brand.replyTo,
      html: emailShell({
        heading: 'A document needs your signature',
        body: `<p>Hi ${escapeHtml(first.name)},</p>
               <p>You've been sent a document to review and sign: <b>${escapeHtml(doc.name)}</b>.</p>
               <p>Click the button to open and sign it.</p>
               ${positionLine}`,
        ctaText: 'Open and sign',
        ctaUrl: link,
        footer: `If you weren't expecting this, you can safely ignore this email.`,
        branding: brand,
      }),
    });
  } catch (mailErr) {
    // eslint-disable-next-line no-console
    console.error('[documents/send] email failed:', mailErr.message);
    emailWarning = `We saved the document but couldn't email ${first.name || first.email} - try Resend in a moment.`;
  }

  if (first.clientId) try {
    const threadRow = await sql`
      INSERT INTO message_threads (workspace_id, client_id)
      VALUES (${workspaceId}, ${first.clientId})
      ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
      RETURNING id
    `;
    const threadId = threadRow.rows[0].id;
    const meta = { docId: doc.id, docName: doc.name };
    await sql`
      INSERT INTO messages (thread_id, sender, text, kind, meta)
      VALUES (${threadId}, 'system', ${`Document sent: ${doc.name}`}, 'doc-sent', ${JSON.stringify(meta)}::jsonb)
    `;
    const preview = `Document sent: ${doc.name}`;
    await sql`
      UPDATE message_threads SET
        last_message_at      = NOW(),
        last_message_preview = ${preview},
        unread_client        = unread_client + 1
      WHERE id = ${threadId}
    `;
  } catch (msgErr) {
    // eslint-disable-next-line no-console
    console.error('[documents/send] thread message failed:', msgErr.message);
  }

  if (first.clientId) notifyClientSafe({
    clientId: first.clientId,
    type: 'documents',
    payload: {
      title: 'Document needs your signature',
      body: doc.name,
      url: `/me/documents`,
      tag: `doc-${doc.id}`,
      requireInteraction: true,
    },
  });

  const signers = await fetchSigners(id);
  return { row: updated.rows[0], signers, link, emailWarning };
}
