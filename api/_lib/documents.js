// Shared serializers + helpers for documents.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { generateRawToken, appUrl } from './tokens.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { notifyClientSafe } from './push.js';
import { docFileUrl } from './docFiles.js';
import { sanitizeDocHtml } from '../../src/lib/docHtml.js';

// The body as shown or copied: always through the allowlist (src/lib/docHtml.js),
// whatever was stored before it existed. The stored text itself is never
// rewritten, so the completion hash of a signed document still matches.
export const docBodyOut = (html) => (html == null ? html : sanitizeDocHtml(html));

export const VALID_KINDS  = new Set(['written', 'pdf']);
export const VALID_STATUS = new Set(['draft', 'sent', 'completed', 'voided', 'declined']);
// Field palette (DocuSign style). 'date' is "Date signed": the server
// fills it with the signing date, whatever the browser sent. 'email' is
// the signer's own address. 'checkbox' stores 'true' or ''. 'dropdown'
// must be one of the field's options.
export const VALID_FIELD_TYPES = new Set([
  'signature', 'initial', 'date', 'name', 'email', 'company', 'title',
  'text', 'checkbox', 'dropdown',
]);
export const MAX_FIELDS = 150;
const MAX_OPTIONS = 50;
const SIG_MAX_CHARS = 400_000;   // a drawn signature PNG as a data URL
const TEXT_MAX_CHARS = 500;
const FIELD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function serializeDoc(row, signers = []) {
  if (!row) return null;
  return {
    id:                  row.id,
    name:                row.name,
    kind:                row.kind,
    contentHtml:         docBodyOut(row.content_html),
    fileUrl:             row.file_url,
    pdfBlobPathname:     row.pdf_blob_pathname || null,
    // A short-lived signed link (api/_lib/docFiles.js), never the raw
    // storage address. Same field name and meaning as before: "open the
    // signed PDF".
    finalPdfUrl:         row.final_pdf_url ? docFileUrl(row.id, 'final') : null,
    sourcePdfSha256:     row.source_pdf_sha256 || null,
    finalPdfSha256:      row.final_pdf_sha256 || null,
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
    viewedAt:      row.viewed_at || null,
    consentAt:     row.consent_at || null,
    linkExpiresAt: row.token_expires_at || null,
  };
}

// Pulls every signer for a document, ordered. Owner-side serializer
// helper so listing pages can show "2 of 4 signed" without extra
// round trips per row.
export async function fetchSigners(documentId) {
  if (!documentId) return [];
  const { rows } = await sql`
    SELECT id, order_index, client_id, is_owner, name, email, status,
           signed_at, declined_at, decline_reason, ip, user_agent,
           viewed_at, consent_at, token_expires_at
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
            signed_at, declined_at, decline_reason, ip, user_agent,
            viewed_at, consent_at, token_expires_at
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
    contentHtml:  docBodyOut(row.content_html),
    // Signed, expiring links to the PDFs (see api/_lib/docFiles.js).
    fileUrl:      row.file_url ? docFileUrl(row.id, 'source') : null,
    finalPdfUrl:  row.final_pdf_url ? docFileUrl(row.id, 'final') : null,
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
//
// Positions: x/y/w/h are 0..1 fractions of the page as displayed (after
// the page's own rotation, inside its crop box), top-left origin. They
// are independent of zoom and screen size; pdfStamp.js maps them back to
// PDF points on the real page, rotation included.
//
// `opts.pageCount` (when known) rejects fields placed on a page the PDF
// doesn't have.
export function cleanFields(input, opts = {}) {
  if (!Array.isArray(input)) return null;
  if (input.length > MAX_FIELDS) return null;
  const pageCount = Number.isInteger(opts.pageCount) && opts.pageCount > 0 ? opts.pageCount : null;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < input.length; i++) {
    const f = input[i];
    if (!f || typeof f !== 'object') return null;
    const type = (f.type || '').toString();
    if (!VALID_FIELD_TYPES.has(type)) return null;
    // signerIndex maps a field to a specific signer (0-based). Default
    // 0 = first signer fills it, matching the legacy single-signer
    // behavior.
    const x = typeof f.x === 'number' ? clamp01(f.x) : null;
    let y = typeof f.y === 'number' ? clamp01(f.y) : null;
    let w = typeof f.w === 'number' ? clamp01(f.w) : null;
    let h = typeof f.h === 'number' ? clamp01(f.h) : null;
    if (w !== null) w = Math.max(0.005, x !== null ? Math.min(w, 1 - x) : w);
    if (h !== null) h = Math.max(0.005, h);
    if (y !== null && h !== null && y + h > 1) y = Math.max(0, 1 - h);
    const page = Number.isInteger(f.page) ? Math.max(0, Math.min(f.page, 999)) : 0;
    if (pageCount && page >= pageCount) return null;
    // Ids are referenced by signer submissions and rendered as DOM keys:
    // keep them short and plain, and never let two fields share one.
    let id = typeof f.id === 'string' && FIELD_ID_RE.test(f.id) ? f.id : null;
    if (!id || seen.has(id)) id = `f${i}_${crypto.randomBytes(4).toString('hex')}`;
    seen.add(id);
    const cleaned = {
      id,
      type,
      label: (f.label || '').toString().slice(0, 120),
      required: f.required !== false,  // default to required
      value: typeof f.value === 'string' ? f.value.slice(0, type === 'signature' || type === 'initial' ? SIG_MAX_CHARS : TEXT_MAX_CHARS) : '',
      page,
      signerIndex: Number.isInteger(f.signerIndex) ? Math.max(0, Math.min(f.signerIndex, 9)) : 0,
      x, y, w, h,
    };
    if (type === 'dropdown') {
      const raw = Array.isArray(f.options) ? f.options : [];
      const uniq = [];
      for (const o of raw) {
        const v = String(o ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (v && !uniq.includes(v)) uniq.push(v);
        if (uniq.length >= MAX_OPTIONS) break;
      }
      cleaned.options = uniq;
    }
    out.push(cleaned);
  }
  return out;
}

const fieldOwner = (f) => (Number.isInteger(f.signerIndex) ? f.signerIndex : 0);

export const FIELD_TYPE_LABEL = {
  signature: 'Signature', initial: 'Initials', date: 'Date signed', name: 'Full name',
  email: 'Email', company: 'Company', title: 'Title', text: 'Text', checkbox: 'Checkbox',
  dropdown: 'Dropdown',
};
const labelOf = (f) => f.label || FIELD_TYPE_LABEL[f.type] || 'Field';

// "Nov 5, 2026" in the business's time zone: what a Date signed field
// shows. The server always decides this value.
export function formatSignedDate(when = new Date(), timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: timeZone || 'UTC' }).format(when);
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(when);
  }
}

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

function validDrawn(value) {
  if (!PNG_DATA_URL.test(value)) return false;
  try {
    const head = Buffer.from(value.slice(22, 22 + 16), 'base64');
    return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  } catch { return false; }
}

// Merge one signer's submission onto the stored fields.
//
// The server is the authority here, not the browser:
//   - only fields assigned to this signer (signerIndex === myIdx) take a
//     submitted value; anything sent for someone else's field is ignored
//   - Date signed is set to today (business time zone), Email to the
//     signer's own address
//   - required fields must be filled (a required checkbox must be ticked)
//   - dropdown answers must be one of the options; text is length capped;
//     a signature is either a drawn PNG or typed text
// Returns { merged } or { error } (a plain-language message).
export function applySignerValues({ stored, submitted, myIdx, signer = {}, signedDate }) {
  const byId = new Map();
  for (const s of (Array.isArray(submitted) ? submitted : [])) {
    if (s && typeof s.id === 'string') byId.set(s.id, s);
  }
  const merged = [];
  for (const f of (stored || [])) {
    if (!VALID_FIELD_TYPES.has(f.type)) return { error: 'This document has a field type that can no longer be signed. Please ask the sender to resend it.' };
    if (fieldOwner(f) !== myIdx) { merged.push({ ...f, value: f.value || '' }); continue; }
    const sub = byId.get(f.id);
    let v = sub && typeof sub.value === 'string' ? sub.value : '';
    const required = f.required !== false;
    switch (f.type) {
      case 'date':
        v = signedDate || formatSignedDate();
        break;
      case 'email':
        v = String(signer.email || v || '').trim().slice(0, 200);
        if (v && !EMAIL_RE.test(v)) return { error: `Please enter a valid email for "${labelOf(f)}"` };
        break;
      case 'checkbox':
        v = (v === 'true' || v === 'on' || v === '1' || v === 'yes') ? 'true' : '';
        if (required && !v) return { error: `Please tick "${labelOf(f)}"` };
        break;
      case 'dropdown': {
        v = v.trim();
        const options = Array.isArray(f.options) ? f.options : [];
        if (v && !options.includes(v)) return { error: `Please pick one of the choices for "${labelOf(f)}"` };
        break;
      }
      case 'signature':
      case 'initial': {
        if (v.startsWith('data:')) {
          if (v.length > SIG_MAX_CHARS || !validDrawn(v)) return { error: `Please sign "${labelOf(f)}" again` };
        } else {
          v = v.replace(/\s+/g, ' ').trim().slice(0, f.type === 'initial' ? 8 : 120);
        }
        break;
      }
      default:
        v = v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, TEXT_MAX_CHARS);
    }
    if (required && !v) {
      return { error: `Please fill in "${labelOf(f)}"` };
    }
    merged.push({ ...f, value: v });
  }
  return { merged };
}

// Checks before a send: every signer has something to sign and every
// field belongs to someone who is actually signing. Returns an error
// message or null.
export function fieldProblemsForSend(doc, signerCount) {
  const fields = Array.isArray(doc?.fields) ? doc.fields : [];
  if (doc?.kind === 'pdf' && !doc.file_url) return 'Upload the PDF before sending.';
  if (doc?.kind === 'pdf' && fields.length === 0) return 'Add at least one field (like a Signature) to the PDF before sending.';
  const highest = fields.reduce((m, f) => Math.max(m, fieldOwner(f)), -1);
  if (highest >= signerCount) {
    return `This document has fields for signer ${highest + 1}, but you picked ${signerCount} signer${signerCount === 1 ? '' : 's'}. Add another signer or move those fields.`;
  }
  for (let i = 0; i < signerCount; i++) {
    if (!fields.some((f) => fieldOwner(f) === i)) {
      return `Signer ${i + 1} has no fields to fill in. Add a Signature for them, or remove them from the list.`;
    }
  }
  const emptyDropdown = fields.find((f) => f.type === 'dropdown' && !(Array.isArray(f.options) && f.options.length));
  if (emptyDropdown) return `The dropdown "${labelOf(emptyDropdown)}" has no choices yet. Add some in the field settings.`;
  return null;
}

// Copy a document (or template) into a new row for this workspace. Used
// for "Save as template" and "Send a template to clients". Field values
// are blanked; the PDF file is shared (it is never modified in place, and
// blob-prune keeps it while any row references its pathname).
export async function cloneDocument({ workspaceId, src, name, asTemplate = false, client = null }) {
  const fields = (Array.isArray(src.fields) ? src.fields : []).map((f) => ({ ...f, value: '' }));
  const { rows } = await sql`
    INSERT INTO documents (
      workspace_id, name, kind, content_html, file_url, pdf_blob_pathname, page_count,
      source_pdf_sha256, fields, is_template, template_id,
      recipient_client_id, recipient_name, recipient_email
    ) VALUES (
      ${workspaceId}, ${String(name || src.name || 'Untitled').slice(0, 200)}, ${src.kind || 'written'},
      ${docBodyOut(src.content_html) || null}, ${src.file_url || null}, ${src.pdf_blob_pathname || null},
      ${src.page_count || 1}, ${src.source_pdf_sha256 || null},
      ${JSON.stringify(fields)}::jsonb, ${!!asTemplate},
      ${asTemplate ? null : (src.is_template ? src.id : (src.template_id || null))},
      ${client?.id || null}, ${client?.name || null}, ${client?.email || null}
    )
    RETURNING *
  `;
  return rows[0];
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
  let emailResult = null;
  try {
    emailResult = await sendEmailToClient({
      clientId: first.clientId || null, workspaceId,
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
    emailResult = { ok: false, sent: false, reason: mailErr.message };
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
  // emailResult: what the client email sender answered ({ sent, reason }),
  // so a caller can say truthfully whether the email went out (a client
  // who turned off document emails is skipped without an error).
  return { row: updated.rows[0], signers, link, emailWarning, emailResult };
}

// Void a document so every sign link stops working. The one path behind
// POST /api/documents/void and Ivy's void_document. Returns { error } or
// { row }. The owner can edit it again afterwards.
export async function voidDocument({ workspaceId, id }) {
  const doc = await fetchOwnedDoc({ id, workspaceId });
  if (!doc) return { error: 'Document not found' };
  if (doc.status === 'completed') return { error: "Can't void a completed document" };
  const newActivity = [
    ...(doc.activity || []),
    { ts: new Date().toISOString(), kind: 'voided', text: 'Document voided' },
  ];
  // Kill every outstanding sign link, not just the legacy single-signer
  // one on the documents row: multi-signer flows mint a token per signer
  // in document_signers, and signers 2..N must not complete a voided doc.
  const updated = await sql`
    UPDATE documents SET
      status = 'voided',
      sign_token_hash = NULL,
      activity = ${JSON.stringify(newActivity)}::jsonb,
      updated_at = NOW()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
    RETURNING *
  `;
  if (updated.rows.length === 0) return { error: 'Document not found - was it deleted while you were voiding it?' };
  try {
    // Nulling the token is enough: sign/[token] resolves by hash. Status
    // stays 'awaiting' (the CHECK constraint has no 'voided' here).
    await sql`
      UPDATE document_signers SET sign_token_hash = NULL, updated_at = NOW()
       WHERE document_id = ${id}
         AND document_id IN (SELECT id FROM documents WHERE id = ${id} AND workspace_id = ${workspaceId})
    `;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[documents/void] document_signers cleanup failed:', e.message);
  }
  return { row: updated.rows[0] };
}

// Who a resend would go to: the signer whose turn it is, or the legacy
// single recipient. Returns { error } or { doc, target, signerCount }.
export async function resendTarget({ workspaceId, id }) {
  const doc = await fetchOwnedDoc({ id, workspaceId });
  if (!doc) return { error: 'Document not found' };
  if (doc.status === 'completed') return { error: 'Already signed - nothing to resend' };
  if (doc.status === 'voided') return { error: 'Document is voided' };
  if (doc.status === 'draft') return { error: "Draft hasn't been sent - use Send instead" };
  if (doc.status === 'declined') return { error: 'Document was declined - revise + resend a new copy' };
  const { rows: signers } = await sql`
    SELECT id, client_id, name, email, order_index, status
      FROM document_signers
     WHERE document_id = ${id}
     ORDER BY order_index ASC
  `;
  let target = signers.find((x) => x.status === 'awaiting') || null;
  if (!target && doc.recipient_email) {
    target = { id: null, client_id: doc.recipient_client_id, name: doc.recipient_name, email: doc.recipient_email, order_index: 0 };
  }
  if (!target) return { error: 'No pending signer to resend to' };
  if (!target.email) return { error: 'Current signer has no email on file' };
  return { doc, target, signerCount: signers.length };
}

// Re-email the current signer with a fresh link (the old link stops
// working). The one path behind POST /api/documents/resend and Ivy's
// resend_document. Returns { error } or { row, target, emailWarning, emailResult }.
export async function resendDocument({ workspaceId, id }) {
  const found = await resendTarget({ workspaceId, id });
  if (found.error) return found;
  const { doc, target, signerCount } = found;
  const raw = generateRawToken(32);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  if (target.id) {
    await sql`
      UPDATE document_signers SET sign_token_hash = ${hash}, status = 'awaiting', updated_at = NOW()
       WHERE id = ${target.id} AND document_id = ${id}`;
  }
  // Keep the legacy fields on documents in sync so the owner list and the
  // sign flow both see the latest token.
  const newActivity = [
    ...(doc.activity || []),
    { ts: new Date().toISOString(), kind: 'sent', text: `Resent to ${target.name || target.email}` },
  ];
  await sql`
    UPDATE documents SET
      recipient_client_id = ${target.client_id || null},
      recipient_name      = ${target.name || ''},
      recipient_email     = ${target.email},
      sign_token_hash     = ${hash},
      activity            = ${JSON.stringify(newActivity)}::jsonb,
      updated_at          = NOW()
    WHERE id = ${id} AND workspace_id = ${workspaceId}
  `;
  const link = `${appUrl()}/sign/${encodeURIComponent(raw)}`;
  const branding = await fetchBranding(workspaceId).catch(() => ({}));
  const position = signerCount > 1
    ? `<p style="font-size:13px;color:#85827B;">You're signer ${target.order_index + 1} of ${signerCount}.</p>`
    : '';
  let emailWarning = null;
  let emailResult = null;
  try {
    emailResult = await sendEmailToClient({
      clientId: target.client_id || null, workspaceId,
      type: 'documents',
      to: target.email,
      subject: `Reminder: please sign "${doc.name}"`,
      replyTo: branding.replyTo,
      html: emailShell({
        heading: 'Document still waiting on you',
        body: `<p>Hi ${escapeHtml(target.name || 'there')},</p>
               <p>This is a friendly nudge - <b>${escapeHtml(doc.name)}</b> is still waiting on your signature.</p>
               ${position}`,
        ctaText: 'Open and sign',
        ctaUrl: link,
        footer: "If you weren't expecting this, you can safely ignore.",
        branding,
      }),
    });
  } catch (mailErr) {
    // eslint-disable-next-line no-console
    console.error('[documents/resend] email failed:', mailErr.message);
    emailWarning = `We refreshed the link but the email to ${target.name || target.email} didn't go through - try again in a moment.`;
    emailResult = { ok: false, sent: false, reason: mailErr.message };
  }
  const row = await fetchOwnedDoc({ id, workspaceId });
  return { row, target, emailWarning, emailResult };
}

export const MAX_TEMPLATE_RECIPIENTS = 50;

// Everything a "send this template to these clients" needs, checked
// without sending: the template, its fields for the signer count, the
// owner's own email when they sign too, and each client (missing or with
// no email are skipped). `owner` = { name, email } of the signed-in owner.
// Returns { error } or { template, owner, sendTo: [{ id, name, email }], skipped }.
export async function prepareTemplateSend({ workspaceId, templateId, clientIds, ownerSigns = null, owner = null }) {
  const ids = [...new Set((Array.isArray(clientIds) ? clientIds : []).map(String)
    .filter((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)))];
  if (ids.length === 0) return { error: 'Pick at least one client' };
  if (ids.length > MAX_TEMPLATE_RECIPIENTS) return { error: `Up to ${MAX_TEMPLATE_RECIPIENTS} clients at a time` };
  const tpl = templateId ? await fetchOwnedDoc({ id: String(templateId), workspaceId }) : null;
  if (!tpl || !tpl.is_template) return { error: 'Template not found' };
  const signs = ownerSigns === 'first' || ownerSigns === 'last' ? ownerSigns : null;
  const problem = fieldProblemsForSend(tpl, signs ? 2 : 1);
  if (problem) return { error: signs ? problem : `${problem} (If you sign this too, turn on "I sign it too".)` };
  let self = null;
  if (signs) {
    const email = String(owner?.email || '').toLowerCase().trim();
    if (!email) return { error: 'Your account has no email address to send your signing link to' };
    self = { clientId: null, name: String(owner?.name || 'Business owner').slice(0, 200), email, isOwner: true };
  }
  const { rows: clients } = await sql`
    SELECT id, name, email FROM clients
     WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::uuid[])
  `;
  const byId = new Map(clients.map((c) => [c.id, c]));
  const sendTo = [];
  const skipped = [];
  for (const cid of ids) {
    const c = byId.get(cid);
    if (!c) { skipped.push({ clientId: cid, name: null, reason: 'not found' }); continue; }
    const email = String(c.email || '').toLowerCase().trim();
    if (!email) { skipped.push({ clientId: cid, name: c.name, reason: 'no email' }); continue; }
    sendTo.push({ id: c.id, name: c.name || email, email });
  }
  return { template: tpl, ownerSigns: signs, self, sendTo, skipped };
}

// Send a template to many clients: each gets their own copy, sent through
// sendDocumentForSigning. The one path behind POST
// /api/documents/send-template and Ivy's send_document_from_template.
// Returns { error } or { sent: [{ clientId, documentId, warning?, emailed }], skipped }.
export async function sendTemplateToClients({ workspaceId, templateId, clientIds, ownerSigns = null, owner = null }) {
  const prep = await prepareTemplateSend({ workspaceId, templateId, clientIds, ownerSigns, owner });
  if (prep.error) return prep;
  const { template: tpl, self, sendTo, skipped } = prep;
  const branding = await fetchBranding(workspaceId).catch(() => ({}));
  const sent = [];
  for (const client of sendTo) {
    // eslint-disable-next-line no-await-in-loop
    const copy = await cloneDocument({ workspaceId, src: tpl, name: `${tpl.name} - ${client.name}`.slice(0, 200), client });
    const me = { clientId: client.id, name: client.name, email: client.email };
    const recipients = prep.ownerSigns === 'first' ? [self, me] : prep.ownerSigns === 'last' ? [me, self] : [me];
    // eslint-disable-next-line no-await-in-loop
    const r = await sendDocumentForSigning({ workspaceId, doc: copy, recipients, branding });
    sent.push({
      clientId: client.id, documentId: copy.id,
      ...(r.emailWarning ? { warning: r.emailWarning } : {}),
      emailed: !!r.emailResult?.sent,
    });
  }
  return { sent, skipped };
}
