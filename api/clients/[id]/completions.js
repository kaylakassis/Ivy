// /api/clients/:id/completions
//   GET → list every service-completion entry for this client across
//         all their bookings, newest first. Each row in the response
//         represents a single completed occurrence (so a weekly
//         recurring booking surfaces as N entries here, one per
//         completed date).
//
// Owner-only. Powers the "Service log" tab on the ClientDrawer.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { fetchOwnedClient } from '../../_lib/clients.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id: clientId } = req.query;

    const client = await fetchOwnedClient({ id: clientId, workspaceId });
    if (!client) return notFound(res, 'Client not found');

    const { rows } = await sql`
      SELECT b.id AS booking_id, b.completion_log, b.date AS booking_date,
             b.start_min, b.end_min, b.service_id, b.staff_id,
             s.name AS service_name,
             sm.name AS staff_name
        FROM bookings b
        LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
        LEFT JOIN staff_members sm ON sm.id = b.staff_id
       WHERE b.client_id = ${clientId}
         AND b.workspace_id = ${workspaceId}
         AND b.completion_log <> '{}'::jsonb
       ORDER BY b.date DESC
       LIMIT 500
    `;

    const entries = [];
    for (const r of rows) {
      const log = r.completion_log || {};
      for (const [occurrenceDate, raw] of Object.entries(log)) {
        if (!raw || typeof raw !== 'object') continue;
        entries.push({
          bookingId: r.booking_id,
          occurrenceDate,
          startMin: r.start_min,
          endMin: r.end_min,
          serviceId: r.service_id,
          serviceName: r.service_name || null,
          staffName: r.staff_name || null,
          completedAt: raw.completedAt || null,
          notes: typeof raw.notes === 'string' ? raw.notes : '',
          attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
          visibleToClient: raw.visibleToClient !== false,
        });
      }
    }
    entries.sort((a, b) => {
      const ad = String(a.completedAt || a.occurrenceDate);
      const bd = String(b.completedAt || b.occurrenceDate);
      return bd.localeCompare(ad);
    });

    return ok(res, { entries });
  } catch (err) {
    return serverError(res, err);
  }
}
