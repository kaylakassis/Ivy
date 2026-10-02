// /api/me/reports - abuse reports filed by a client.
//   GET  → { reports: [...] } this user's own reports, newest first
//   POST { workspaceId, targetType ('business'|'message'|'group_message'), targetId?, reason, details? }
//        → files a report about that business for the operator to review
//
// The workspace must be one the user has a client row in (via myClientIds).
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds } from '../_lib/clientPortal.js';
import { createReport, normalizeReportInput, serializeReport } from '../_lib/moderation.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const CLIENT_TARGETS = new Set(['business', 'message', 'group_message']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT r.*, COALESCE(cs.biz_name, w.name) AS business_name
          FROM abuse_reports r
          JOIN workspaces w ON w.id = r.workspace_id
          LEFT JOIN calendar_settings cs ON cs.workspace_id = r.workspace_id
         WHERE r.reporter_user_id = ${user.id} AND r.reporter_role = 'client'
         ORDER BY r.created_at DESC
         LIMIT 200
      `;
      return ok(res, { reports: rows.map(serializeReport) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const workspaceId = body.workspaceId ? String(body.workspaceId) : null;
      if (!workspaceId) return badRequest(res, 'workspaceId is required');
      const targetType = String(body.targetType || 'business');
      if (!CLIENT_TARGETS.has(targetType)) return badRequest(res, 'Invalid targetType');
      const norm = normalizeReportInput(body);
      if (norm.error) return badRequest(res, norm.error);

      const memberships = await myClientIds(user);
      const m = memberships.find((x) => x.workspaceId === workspaceId);
      if (!m) return badRequest(res, 'You are not a client of that business');

      const report = await createReport({
        workspaceId,
        // Keep the reporter's own client row on the report so the operator
        // can see which relationship it came from.
        clientId: m.clientId,
        reporterUserId: user.id, reporterRole: 'client',
        targetType, targetId: norm.targetId, reason: norm.reason, details: norm.details,
      });
      return created(res, { report: serializeReport(report) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
