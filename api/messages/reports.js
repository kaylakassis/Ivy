// /api/messages/reports - abuse reports filed by the business owner.
//   GET  → { reports: [...] } the owner's own reports, newest first
//   POST { clientId, targetType ('client'|'message'|'group_message'), targetId?, reason, details? }
//        → files a report for the operator to review (Admin → Reports)
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { createReport, normalizeReportInput, serializeReport } from '../_lib/moderation.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const OWNER_TARGETS = new Set(['client', 'message', 'group_message']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT r.*, c.name AS client_name
          FROM abuse_reports r
          LEFT JOIN clients c ON c.id = r.client_id
         WHERE r.workspace_id = ${workspaceId} AND r.reporter_role = 'owner' AND r.reporter_user_id = ${user.id}
         ORDER BY r.created_at DESC
         LIMIT 200
      `;
      return ok(res, { reports: rows.map(serializeReport) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const clientId = body.clientId ? String(body.clientId) : null;
      if (!clientId) return badRequest(res, 'clientId is required');
      const targetType = String(body.targetType || 'client');
      if (!OWNER_TARGETS.has(targetType)) return badRequest(res, 'Invalid targetType');
      const norm = normalizeReportInput(body);
      if (norm.error) return badRequest(res, norm.error);

      const cl = await sql`SELECT id FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
      if (cl.rows.length === 0) return badRequest(res, 'Unknown client');

      const report = await createReport({
        workspaceId, clientId, reporterUserId: user.id, reporterRole: 'owner',
        targetType, targetId: norm.targetId, reason: norm.reason, details: norm.details,
      });
      return created(res, { report: serializeReport(report) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
