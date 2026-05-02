// GET /api/me/bookings — list every booking across the businesses the user
// is a client of. Grouped server-side: { upcoming, past, cancelled }.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return ok(res, { upcoming: [], past: [], cancelled: [] });

    const byClient = new Map(memberships.map((m) => [m.clientId, m]));

    const { rows } = await sql.query(
      `SELECT b.id, b.workspace_id, b.client_id, b.service_id,
              b.date, b.start_min, b.end_min, b.notes, b.cancelled_at,
              s.name AS service_name,
              s.duration_minutes, s.price
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id
       WHERE b.client_id = ANY($1)
       ORDER BY b.date DESC, b.start_min DESC
       LIMIT 500`,
      [myIds],
    );

    const today = new Date().toISOString().slice(0, 10);
    const upcoming = [];
    const past = [];
    const cancelled = [];
    for (const r of rows) {
      const dateISO = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date;
      const m = byClient.get(r.client_id);
      const item = {
        id: r.id,
        date: dateISO,
        startMin: r.start_min,
        endMin: r.end_min,
        notes: r.notes,
        serviceName: r.service_name,
        durationMinutes: r.duration_minutes,
        price: r.price != null ? Number(r.price) : null,
        cancelledAt: r.cancelled_at,
        businessName: m?.businessName || 'Business',
        clientId: r.client_id,
      };
      if (r.cancelled_at) cancelled.push(item);
      else if (dateISO >= today) upcoming.push(item);
      else past.push(item);
    }
    upcoming.sort((a, b) => (a.date + String(a.startMin).padStart(4, '0'))
      .localeCompare(b.date + String(b.startMin).padStart(4, '0')));
    return ok(res, { upcoming, past, cancelled });
  } catch (err) {
    return serverError(res, err);
  }
}
