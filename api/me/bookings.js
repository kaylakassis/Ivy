// GET /api/me/bookings - list every booking across the businesses the user
// is a client of. Grouped server-side: { upcoming, past, cancelled }.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { myClientIds, ids } from '../_lib/clientPortal.js';
import { computeBookingPayment } from '../_lib/calendar.js';
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

    let rows;
    try { ({ rows } = await sql.query(
      `SELECT b.id, b.workspace_id, b.client_id, b.service_id,
              b.date, b.start_min, b.end_min, b.notes, b.cancelled_at,
              b.video_room_url, b.location_address, b.tip_amount,
              b.completion_log, b.booking_total, b.deposit_paid,
              s.name AS service_name,
              s.duration_minutes, s.price, s.capacity AS service_capacity,
              s.location_type AS service_location_type,
              s.cancellation_fee_amount, s.cancellation_window_hours,
              cs.slug AS biz_slug,
              ci.status AS collect_invoice_status, ci.paid_amount AS collect_invoice_paid_amount
       FROM bookings b
       LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
       LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
       LEFT JOIN invoices ci ON ci.id = b.collect_invoice_id AND ci.workspace_id = b.workspace_id
       WHERE b.client_id = ANY($1)
       ORDER BY b.date DESC, b.start_min DESC
       LIMIT 500`,
      [myIds],
    )); } catch (e) {
      // Partial schema or missing service column - degrade to empty
      // groups rather than 500ing the whole portal.
      // eslint-disable-next-line no-console
      console.error('[me/bookings] query failed (returning empty):', e.message);
      return ok(res, { upcoming: [], past: [], cancelled: [] });
    }

    const today = new Date().toISOString().slice(0, 10);
    const upcoming = [];
    const past = [];
    const cancelled = [];
    for (const r of rows) {
      const dateISO = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date;
      const m = byClient.get(r.client_id);
      // Server-side redaction: only surface the completion entry for
      // THIS occurrence, and only when visibleToClient is true. Never
      // trust the client to honor the flag.
      const completionEntry = (r.completion_log && typeof r.completion_log === 'object')
        ? r.completion_log[dateISO] : null;
      const visible = completionEntry && completionEntry.visibleToClient !== false;
      const item = {
        id: r.id,
        date: dateISO,
        startMin: r.start_min,
        endMin: r.end_min,
        notes: r.notes,
        serviceId: r.service_id,
        serviceName: r.service_name,
        serviceCapacity: r.service_capacity || 1,
        serviceLocationType: r.service_location_type || 'in_person',
        durationMinutes: r.duration_minutes,
        price: r.price != null ? Number(r.price) : null,
        cancelledAt: r.cancelled_at,
        // Cancellation policy - lets the portal warn the client BEFORE a
        // late-cancel fee is auto-charged on their card.
        cancellationFeeAmount: Number(r.cancellation_fee_amount || 0),
        cancellationWindowHours: Number.isInteger(r.cancellation_window_hours)
          ? r.cancellation_window_hours : 24,
        videoRoomUrl: r.video_room_url || null,
        locationAddress: r.location_address || null,
        tipAmount: Number(r.tip_amount || 0),
        businessName: m?.businessName || 'Business',
        // Slug + workspaceId let the client-side reschedule modal fetch
        // the public availability + slot grid without duplicating
        // server-side scoping logic. Don't echo workspaceId externally
        // - but the slug is already public.
        bizSlug: r.biz_slug || null,
        clientId: r.client_id,
        completedAt: visible ? completionEntry.completedAt : null,
        completionNotes: visible ? (completionEntry.notes || '') : null,
        completionAttachments: visible ? (completionEntry.attachments || []) : [],
        // Unified deposit + balance payment status for this appointment.
        payment: computeBookingPayment(r),
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
