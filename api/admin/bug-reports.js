// Super-admin inbox for /api/bug-reports submissions.
//   GET    /api/admin/bug-reports[?status=open|triaged|resolved|dismissed]
//          Lists most recent 200 reports, newest first.
//   PATCH  /api/admin/bug-reports  { id, status?, admin_notes? }
//          Triage a report. Audit-logged.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const VALID_STATUS = new Set(['open', 'triaged', 'resolved', 'dismissed']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    if (req.method === 'GET') return list(req, res);
    if (req.method === 'PATCH') return triage(req, res);
    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}

async function list(req, res) {
  const status = (req.query.status || '').toString();
  const filter = VALID_STATUS.has(status) ? status : null;
  const { rows } = filter
    ? await sql`
        SELECT id, user_id, user_email, workspace_id, url, title, body,
               severity, user_agent, viewport, app_version, status,
               admin_notes, created_at, updated_at
          FROM bug_reports
         WHERE status = ${filter}
         ORDER BY created_at DESC
         LIMIT 200`
    : await sql`
        SELECT id, user_id, user_email, workspace_id, url, title, body,
               severity, user_agent, viewport, app_version, status,
               admin_notes, created_at, updated_at
          FROM bug_reports
         ORDER BY created_at DESC
         LIMIT 200`;
  // Open-count for the badge on the admin tab.
  const openCountRow = await sql`SELECT COUNT(*)::int AS n FROM bug_reports WHERE status = 'open'`;
  return ok(res, {
    reports: rows.map(serialize),
    openCount: openCountRow.rows[0]?.n || 0,
  });
}

async function triage(req, res) {
  const { id, status, adminNotes } = await readBody(req);
  if (!id) return badRequest(res, 'id is required');
  if (status != null && !VALID_STATUS.has(status)) {
    return badRequest(res, `status must be one of ${[...VALID_STATUS].join(', ')}`);
  }
  const sets = [];
  const vals = [];
  const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  if (status != null) push('status', status);
  if (adminNotes != null) push('admin_notes', String(adminNotes).slice(0, 2000));
  if (sets.length === 0) return badRequest(res, 'Nothing to update');
  vals.push(id);
  const r = await sql.query(
    `UPDATE bug_reports SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${vals.length} RETURNING *`,
    vals,
  );
  if (r.rows.length === 0) return badRequest(res, 'Bug report not found');

  const actor = await getAdminActor(req);
  await recordAudit(req, {
    actor,
    action: 'admin.bug_report.triage',
    meta: { id, status: status || null, hasNotes: adminNotes != null },
  });

  return ok(res, { report: serialize(r.rows[0]) });
}

function serialize(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userEmail: r.user_email,
    workspaceId: r.workspace_id,
    url: r.url,
    title: r.title,
    body: r.body,
    severity: r.severity,
    userAgent: r.user_agent,
    viewport: r.viewport,
    appVersion: r.app_version,
    status: r.status,
    adminNotes: r.admin_notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
