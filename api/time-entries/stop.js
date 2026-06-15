// POST /api/time-entries/stop
//
// Stops the workspace's currently running entry (if any). Computes
// duration_seconds and flips status to 'stopped'. Lives as a static
// sibling so /api/time-entries/stop hits this rather than [id].js.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeEntry } from '../_lib/timeEntries.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const upd = await sql`
      UPDATE time_entries SET
        ended_at         = NOW(),
        duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int),
        status           = 'stopped',
        updated_at       = NOW()
      WHERE workspace_id = ${workspaceId} AND status = 'running'
      RETURNING id
    `;
    if (upd.rows.length === 0) return ok(res, { entry: null });

    const fresh = await sql`
      SELECT t.*, c.name AS client_name, s.name AS service_name
        FROM time_entries t
        LEFT JOIN clients c  ON c.id = t.client_id
        LEFT JOIN services s ON s.id = t.service_id
       WHERE t.id = ${upd.rows[0].id}
    `;
    return ok(res, { entry: serializeEntry(fresh.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}
