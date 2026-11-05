// GET /api/cancellation-policy/acceptances?clientId=<uuid>
// GET /api/cancellation-policy/acceptances?bookingId=<uuid>
//
// Owner only. The client's (or booking's) cancellation policy acceptance
// records, newest first, scoped to the owner's workspace. For a booking
// with no record the response also says whether it was booked by the
// business (no client acceptance expected) and whether a "please accept"
// link was emailed.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { listAcceptances, getPolicySettings } from '../_lib/cancellationPolicy.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const clientId = req.query.clientId ? String(req.query.clientId) : null;
    const bookingId = req.query.bookingId ? String(req.query.bookingId) : null;
    if (!clientId && !bookingId) return badRequest(res, 'clientId or bookingId is required');
    if ((clientId && !UUID.test(clientId)) || (bookingId && !UUID.test(bookingId))) return badRequest(res, 'Invalid id');

    const settings = await getPolicySettings(workspaceId);
    if (bookingId) {
      const b = await sql`
        SELECT id, source, client_id FROM bookings WHERE id = ${bookingId} AND workspace_id = ${workspaceId} LIMIT 1
      `;
      if (b.rows.length === 0) return notFound(res, 'Booking not found');
      const reqs = await sql`
        SELECT created_at, sent_to, accepted_at FROM cancellation_policy_requests
         WHERE workspace_id = ${workspaceId} AND booking_id = ${bookingId}
         ORDER BY created_at DESC LIMIT 5
      `;
      const source = b.rows[0].source || null;
      return ok(res, {
        acceptances: await listAcceptances({ workspaceId, bookingId }),
        // Bookings the business made itself (calendar, Ivy, imports) have no
        // client acceptance unless the owner sent the policy afterwards.
        bookedByBusiness: source !== 'client',
        requests: reqs.rows.map((r) => ({ sentAt: r.created_at, sentTo: r.sent_to, acceptedAt: r.accepted_at })),
        settings,
      });
    }
    const c = await sql`SELECT id FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId} LIMIT 1`;
    if (c.rows.length === 0) return notFound(res, 'Client not found');
    return ok(res, { acceptances: await listAcceptances({ workspaceId, clientId }), settings });
  } catch (err) {
    return serverError(res, err);
  }
}
