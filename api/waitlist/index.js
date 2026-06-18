// GET /api/waitlist - owner: list waitlist entries on this workspace.
// Active (status='waiting') first, then promoted/cancelled history.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeWaitlistEntry } from '../_lib/waitlist.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { rows } = await sql`
      SELECT w.*, s.name AS service_name
      FROM waitlist_entries w
      LEFT JOIN services s ON s.id = w.service_id
      WHERE w.workspace_id = ${workspaceId}
      ORDER BY
        CASE w.status WHEN 'waiting' THEN 0 ELSE 1 END,
        w.created_at ASC
      LIMIT 500
    `;
    return ok(res, {
      entries: rows.map((r) => ({
        ...serializeWaitlistEntry(r),
        serviceName: r.service_name || 'Service',
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
