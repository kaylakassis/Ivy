// Owner↔client messaging moderation: blocks + abuse reports.
//
// Apple App Review requires that anywhere people can write to each
// other there is a way to report objectionable content, a way to block
// an abusive user, and that the operator actually reviews reports.
//
//   contact_blocks  - one row per (workspace, client, direction). A block
//                     in EITHER direction switches messaging off both
//                     ways; the UI tells each side what happened.
//   abuse_reports   - the operator's review queue (Admin → Reports). Each
//                     new report also emails SUPER_ADMIN_EMAIL so it is
//                     seen within 24 hours even if nobody opens /admin.
import { sql } from './db.js';
import { sendEmail, emailShell } from './email.js';
import { appUrl } from './tokens.js';
import { superAdminEmails } from './admin.js';

export const REPORT_REASONS = ['harassment', 'spam', 'inappropriate', 'scam', 'other'];
export const REPORT_REASON_LABELS = {
  harassment:    'Harassment',
  spam:          'Spam',
  inappropriate: 'Inappropriate content',
  scam:          'Scam or fraud',
  other:         'Other',
};
export const REPORT_TARGET_TYPES = ['client', 'business', 'message', 'group_message', 'review'];
export const REPORT_STATUSES = ['open', 'reviewed', 'dismissed'];
export const MAX_DETAILS_CHARS = 2000;

export const BLOCKED_MESSAGE = 'Messaging is turned off between you and this contact.';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// True when a block exists in either direction between this business
// and this client. Both send paths (owner → client, client → business)
// and the client's group-chat post path call this.
export async function isBlocked(workspaceId, clientId) {
  if (!workspaceId || !clientId) return false;
  const { rows } = await sql`
    SELECT 1 FROM contact_blocks
     WHERE workspace_id = ${workspaceId} AND client_id = ${clientId}
     LIMIT 1
  `;
  return rows.length > 0;
}

// Both directions for one pair, so a thread view can say who blocked whom.
export async function blockState(workspaceId, clientId) {
  if (!workspaceId || !clientId) return { blocked: false, ownerBlocked: false, clientBlocked: false };
  const { rows } = await sql`
    SELECT direction FROM contact_blocks
     WHERE workspace_id = ${workspaceId} AND client_id = ${clientId}
  `;
  const dirs = new Set(rows.map((r) => r.direction));
  const ownerBlocked = dirs.has('owner_blocks_client');
  const clientBlocked = dirs.has('client_blocks_business');
  return { blocked: ownerBlocked || clientBlocked, ownerBlocked, clientBlocked };
}

function foldRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.client_id) || { ownerBlocked: false, clientBlocked: false };
    if (r.direction === 'owner_blocks_client') cur.ownerBlocked = true;
    if (r.direction === 'client_blocks_business') cur.clientBlocked = true;
    map.set(r.client_id, cur);
  }
  return map;
}

// client_id → { ownerBlocked, clientBlocked } for a whole workspace.
// Decorates the owner's thread list in one query.
export async function blockMapForWorkspace(workspaceId) {
  if (!workspaceId) return new Map();
  const { rows } = await sql`
    SELECT client_id, direction FROM contact_blocks WHERE workspace_id = ${workspaceId}
  `;
  return foldRows(rows);
}

// Same shape, for the set of client rows one portal user owns.
export async function blockMapForClients(clientIds) {
  if (!Array.isArray(clientIds) || clientIds.length === 0) return new Map();
  const { rows } = await sql.query(
    `SELECT client_id, direction FROM contact_blocks WHERE client_id = ANY($1::uuid[])`,
    [clientIds],
  );
  return foldRows(rows);
}

// Clients the business has blocked, with the client's name/email.
export async function listOwnerBlocks(workspaceId) {
  const { rows } = await sql`
    SELECT b.client_id, b.reason, b.created_at, c.name AS client_name, c.email AS client_email
      FROM contact_blocks b
      JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
     WHERE b.workspace_id = ${workspaceId} AND b.direction = 'owner_blocks_client'
     ORDER BY b.created_at DESC
  `;
  return rows.map((r) => ({
    clientId:    r.client_id,
    clientName:  r.client_name,
    clientEmail: r.client_email,
    reason:      r.reason || null,
    createdAt:   r.created_at,
  }));
}

// Businesses this user (as a client) has blocked, across workspaces.
export async function listClientBlocks(userId) {
  const { rows } = await sql`
    SELECT b.workspace_id, b.created_at, w.name AS workspace_name, cs.biz_name
      FROM contact_blocks b
      JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
      JOIN workspaces w ON w.id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
     WHERE c.user_id = ${userId} AND b.direction = 'client_blocks_business'
     ORDER BY b.created_at DESC
  `;
  return rows.map((r) => ({
    workspaceId:  r.workspace_id,
    businessName: r.biz_name || r.workspace_name || 'Business',
    createdAt:    r.created_at,
  }));
}

export function serializeReport(r) {
  const out = {
    id:             r.id,
    workspaceId:    r.workspace_id,
    clientId:       r.client_id || null,
    reporterRole:   r.reporter_role,
    targetType:     r.target_type,
    targetId:       r.target_id || null,
    reason:         r.reason,
    reasonLabel:    REPORT_REASON_LABELS[r.reason] || r.reason,
    details:        r.details || '',
    status:         r.status,
    resolutionNote: r.resolution_note || null,
    resolvedAt:     r.resolved_at || null,
    createdAt:      r.created_at,
  };
  if (r.business_name !== undefined) out.businessName = r.business_name || '(unnamed business)';
  if (r.client_name !== undefined) out.clientName = r.client_name || null;
  if (r.client_email !== undefined) out.clientEmail = r.client_email || null;
  if (r.reporter_email !== undefined) out.reporterEmail = r.reporter_email || null;
  if (r.resolved_by_email !== undefined) out.resolvedByEmail = r.resolved_by_email || null;
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validates + normalizes the free-form inputs shared by every report
// endpoint. Returns { error } or { reason, details, targetId }.
export function normalizeReportInput({ reason, details, targetId }) {
  const r = String(reason || '').toLowerCase().trim();
  if (!REPORT_REASONS.includes(r)) {
    return { error: `reason must be one of: ${REPORT_REASONS.join(', ')}` };
  }
  const d = details == null ? '' : String(details).trim();
  if (d.length > MAX_DETAILS_CHARS) {
    return { error: `details must be ${MAX_DETAILS_CHARS} characters or fewer` };
  }
  let t = null;
  if (targetId != null && targetId !== '') {
    t = String(targetId);
    if (!UUID_RE.test(t)) return { error: 'targetId must be an id' };
  }
  return { reason: r, details: d || null, targetId: t };
}

// Inserts the report, then best-effort emails the operator. Email
// failure never throws: the row is the source of truth and the admin
// queue shows it regardless.
export async function createReport({
  workspaceId, clientId = null, reporterUserId = null, reporterRole,
  targetType, targetId = null, reason, details = null,
}) {
  const { rows } = await sql`
    INSERT INTO abuse_reports
      (workspace_id, client_id, reporter_user_id, reporter_role, target_type, target_id, reason, details)
    VALUES
      (${workspaceId}, ${clientId}, ${reporterUserId}, ${reporterRole}, ${targetType}, ${targetId}, ${reason}, ${details})
    RETURNING *
  `;
  const report = rows[0];
  try { await notifyOperator(report); } catch { /* row is saved; email is best-effort */ }
  return report;
}

async function notifyOperator(report) {
  const recipients = Array.from(superAdminEmails());
  if (recipients.length === 0) return;
  try {
    const link = `${appUrl()}/admin?tab=reports`;
    const label = REPORT_REASON_LABELS[report.reason] || report.reason;
    const who = report.reporter_role === 'owner' ? 'A business owner' : 'A client';
    const what = String(report.target_type).replace('_', ' ');
    await sendEmail({
      to: recipients,
      subject: 'New abuse report',
      html: emailShell({
        heading: 'New abuse report',
        body: `<p>${who} reported a ${escapeHtml(what)}.</p>
          <p><strong>Reason:</strong> ${escapeHtml(label)}</p>
          ${report.details ? `<p><strong>Details:</strong><br/>${escapeHtml(report.details).replace(/\n/g, '<br/>')}</p>` : ''}
          <p>Please review it within 24 hours.</p>`,
        ctaText: 'Open the reports queue',
        ctaUrl: link,
        footer: `Report id ${escapeHtml(report.id)}`,
      }),
      text: `${who} reported a ${what}. Reason: ${label}. ${report.details || ''}\n\nReview: ${link}`,
    });
  } catch (err) {
    console.warn('[moderation] operator email failed (report saved):', err.message);
  }
}
