// GET /api/helper/schedule?workspaceId=…&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// The helper's own bookings at one business: strictly
//   workspace_id = <their membership> AND staff_id = <their staff row>.
// Returns a deliberately small shape (no money, no other staff, no
// client list beyond the person they are meeting). Recurring series come
// back as masters with recurrenceRule / cancelledOccurrences so the
// frontend expands them with the same util the owner calendar uses.
import { sql } from '../_lib/db.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireHelper } from '../_lib/helpers.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isoDay = (d) => d.toISOString().slice(0, 10);

export function serializeHelperBooking(row) {
  const date = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date;
  const cancelledOccurrences = (row.cancelled_occurrences || []).map((d) =>
    d instanceof Date ? d.toISOString().slice(0, 10) : d,
  );
  // Only the completion facts a helper needs: which occurrences are done.
  const log = row.completion_log && typeof row.completion_log === 'object' ? row.completion_log : {};
  const completed = {};
  for (const [k, v] of Object.entries(log)) {
    completed[k] = { completedAt: v?.completedAt || null, notes: v?.notes || '' };
  }
  return {
    id:               row.id,
    date,
    startMin:         row.start_min,
    endMin:           row.end_min,
    serviceName:      row.service_name || 'Session',
    locationType:     row.location_type || null,
    locationLabel:    row.location_label || null,
    locationAddress:  row.location_address || null,
    videoRoomUrl:     row.video_room_url || null,
    // Notes the owner left on the booking (what to do, where to park).
    notes:            row.notes || null,
    clientId:         row.client_id || null,
    clientName:       row.client_name || null,
    recurrenceRule:   row.recurrence_rule || null,
    recurrenceUntil:  row.recurrence_until instanceof Date
      ? row.recurrence_until.toISOString().slice(0, 10) : (row.recurrence_until || null),
    cancelledOccurrences,
    noShowAt:         row.no_show_at || null,
    completed,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const gate = await requireHelper(req, res, { workspaceId: req.query.workspaceId });
    if (!gate) return;
    const { membership } = gate;

    // Bounded window, like the owner calendar (default: a week back, 60 ahead).
    const dFrom = new Date(); dFrom.setUTCDate(dFrom.getUTCDate() - 7);
    const dTo = new Date(); dTo.setUTCDate(dTo.getUTCDate() + 60);
    const from = isIsoDate(req.query.from) ? req.query.from : isoDay(dFrom);
    const to   = isIsoDate(req.query.to)   ? req.query.to   : isoDay(dTo);

    const { rows } = await sql`
      SELECT b.id, b.date, b.start_min, b.end_min, b.notes, b.client_id, b.client_name,
             b.location_address, b.video_room_url, b.recurrence_rule, b.recurrence_until,
             b.cancelled_occurrences, b.completion_log, b.no_show_at,
             s.name AS service_name, s.location_type, s.location_label
        FROM bookings b
        LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
       WHERE b.workspace_id = ${membership.workspaceId}
         AND b.staff_id = ${membership.staffId}
         AND b.cancelled_at IS NULL
         AND (
           (b.recurrence_rule IS NULL AND b.date >= ${from}::date AND b.date <= ${to}::date)
           OR (b.recurrence_rule IS NOT NULL AND b.date <= ${to}::date
               AND (b.recurrence_until IS NULL OR b.recurrence_until >= ${from}::date))
         )
       ORDER BY b.date, b.start_min
    `;
    return ok(res, {
      workspaceId: membership.workspaceId,
      staffId: membership.staffId,
      from, to,
      bookings: rows.map(serializeHelperBooking),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
