// /api/admin/reports - super-admin abuse report queue (Admin → Reports).
//   GET  ?status=open|reviewed|dismissed|all (default open)
//        → { reports: [...], openCount }
//   PATCH { id, status ('reviewed'|'dismissed'), resolutionNote? }
//        → marks the report resolved by the calling admin; audited.
//
// Reports arrive from owners (api/messages/reports.js) and clients
// (api/me/reports.js); each also emails SUPER_ADMIN_EMAIL on creation.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { readBody } from '../_lib/body.js';
import { serializeReport, REPORT_STATUSES } from '../_lib/moderation.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const RESOLVABLE = new Set(['reviewed', 'dismissed']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    if (req.method === 'GET') {
      const want = String(req.query.status || 'open');
      const status = REPORT_STATUSES.includes(want) ? want : null;
      if (want !== 'all' && !status) return badRequest(res, 'Invalid status');
      const params = [];
      let where = '';
      if (status) { params.push(status); where = `WHERE r.status = $1`; }
      const { rows } = await sql.query(
        `SELECT r.*,
                COALESCE(cs.biz_name, w.name) AS business_name,
                c.name AS client_name, c.email AS client_email,
                ru.email AS reporter_email,
                au.email AS resolved_by_email
           FROM abuse_reports r
           JOIN workspaces w ON w.id = r.workspace_id
           LEFT JOIN calendar_settings cs ON cs.workspace_id = r.workspace_id
           LEFT JOIN clients c ON c.id = r.client_id
           LEFT JOIN users ru ON ru.id = r.reporter_user_id
           LEFT JOIN users au ON au.id = r.resolved_by_user_id
           ${where}
          ORDER BY r.created_at DESC
          LIMIT 500`,
        params,
      );
      const open = await sql`SELECT COUNT(*)::int AS n FROM abuse_reports WHERE status = 'open'`;
      return ok(res, { reports: rows.map(serializeReport), openCount: open.rows[0]?.n || 0 });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const id = body.id ? String(body.id) : null;
      if (!id) return badRequest(res, 'id is required');
      const status = String(body.status || '');
      if (!RESOLVABLE.has(status)) return badRequest(res, "status must be 'reviewed' or 'dismissed'");
      const note = body.resolutionNote == null ? null : String(body.resolutionNote).trim().slice(0, 2000) || null;
      const actor = await getAdminActor(req);

      const { rows } = await sql`
        UPDATE abuse_reports SET
          status = ${status},
          resolution_note = ${note},
          resolved_by_user_id = ${actor?.id || null},
          resolved_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
      if (rows.length === 0) return notFound(res, 'Report not found');
      await recordAudit(req, {
        actor, action: 'abuse_report.resolve',
        meta: { reportId: id, status, hasNote: !!note },
      });
      return ok(res, { report: serializeReport(rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
