// DELETE /api/me/bookings/:id — client cancels their own booking.
//
// Authorization: the booking's client_id must be in the user's myClientIds()
// (i.e. they own the `clients` row this booking is attached to). Walk-ins
// with no client_id can never be cancelled through this endpoint, since by
// definition no user owns them.
//
// Single-occurrence cancel of a recurring series uses
// PATCH { cancelOccurrence: 'YYYY-MM-DD' }.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';
import { serializeBooking, hasConflict, withinAvailability } from '../../_lib/calendar.js';
import { syncOnBookingDeleted, syncOnBookingUpdated, syncOnBookingCreated } from '../../_lib/googleSync.js';
import { restoreCredit } from '../../_lib/packages.js';
import { promoteWaitlistOnCancel } from '../../_lib/waitlist.js';
import { notifyNewBooking } from '../../_lib/bookingNotify.js';
import { attachIntakeForms } from '../../_lib/intake.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { id } = req.query;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return notFound(res, 'Booking not found');

    // Confirm ownership before any mutation.
    const found = await sql.query(
      `SELECT * FROM bookings WHERE id = $1 AND client_id = ANY($2)`,
      [id, myIds],
    );
    if (found.rows.length === 0) return notFound(res, 'Booking not found');
    const booking = found.rows[0];

    if (req.method === 'DELETE') {
      if (booking.cancelled_at) return badRequest(res, 'Booking already cancelled');
      // Soft-cancel. Defense-in-depth: include client_id IN (...) on the
      // UPDATE so a future regression in the ownership check above can't
      // cancel another tenant's booking.
      await sql.query(
        `UPDATE bookings SET cancelled_at = NOW()
         WHERE id = $1 AND client_id = ANY($2) AND cancelled_at IS NULL`,
        [id, myIds],
      );
      // Drop a system note in the thread so the business sees the cancellation.
      await postCancellationNote({
        workspaceId: booking.workspace_id,
        clientId: booking.client_id,
        booking,
      });
      syncOnBookingDeleted({ workspaceId: booking.workspace_id, googleEventId: booking.google_event_id });
      // Refund any consumed package credit.
      await restoreCredit({ workspaceId: booking.workspace_id, clientPackageId: booking.client_package_id });
      // Promote next waitlist entry. Best-effort.
      try {
        const promoted = await promoteWaitlistOnCancel({
          workspaceId: booking.workspace_id,
          serviceId: booking.service_id,
          dateISO:   booking.date,
          startMin:  booking.start_min,
          endMin:    booking.end_min,
        });
        if (promoted) {
          notifyNewBooking({ workspaceId: booking.workspace_id, bookingId: promoted.id, source: 'waitlist' });
          syncOnBookingCreated({ workspaceId: booking.workspace_id, bookingId: promoted.id });
          attachIntakeForms({ workspaceId: booking.workspace_id, bookingId: promoted.id });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[waitlist] promote failed on cancel:', err.message);
      }
      return noContent(res);
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);

      // Reschedule path: { rescheduleTo: { date, startMin, endMin } }
      // — moves the booking to a new slot. Server-validates against the
      // workspace's availability + active bookings, including a
      // self-exclusion so the booking's own current slot doesn't count
      // as a conflict if the user re-picks the same slot.
      if (body.rescheduleTo && typeof body.rescheduleTo === 'object') {
        if (booking.cancelled_at) return badRequest(res, "Can't reschedule a cancelled booking");
        if (booking.recurrence_rule) {
          return badRequest(res, 'Recurring bookings can\'t be rescheduled — cancel this occurrence and book a new one.');
        }
        const r = body.rescheduleTo;
        const newDate  = (r.date || '').toString();
        const newStart = Number(r.startMin);
        const newEnd   = Number(r.endMin);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return badRequest(res, 'rescheduleTo.date must be YYYY-MM-DD');
        if (!Number.isInteger(newStart) || newStart < 0 || newStart >= 24 * 60) {
          return badRequest(res, 'rescheduleTo.startMin out of range');
        }
        if (!Number.isInteger(newEnd) || newEnd <= newStart || newEnd > 24 * 60) {
          return badRequest(res, 'rescheduleTo.endMin out of range');
        }
        const today = new Date().toISOString().slice(0, 10);
        if (newDate < today) return badRequest(res, "Can't reschedule into the past");

        // Pull the workspace's availability + the service's capacity
        // for conflict-checking. If the service was deleted (orphan
        // booking), default capacity to 1.
        const cs = await sql`
          SELECT availability FROM calendar_settings WHERE workspace_id = ${booking.workspace_id}
        `;
        const availability = cs.rows[0]?.availability || {};
        const weekday = new Date(newDate + 'T00:00:00').getDay();
        if (!withinAvailability(availability, weekday, newStart, newEnd)) {
          return badRequest(res, "That time isn't in the business's available hours.");
        }

        let capacity = 1;
        if (booking.service_id) {
          const sv = await sql`SELECT capacity FROM services WHERE id = ${booking.service_id} AND workspace_id = ${booking.workspace_id}`;
          if (sv.rows[0]?.capacity) capacity = Number(sv.rows[0].capacity);
        }

        const conflict = await hasConflict({
          workspaceId: booking.workspace_id,
          dateISO: newDate,
          start: newStart,
          end: newEnd,
          serviceId: booking.service_id,
          capacity,
          excludeBookingId: booking.id,
        });
        if (conflict) return badRequest(res, 'That slot is no longer available — pick another time.');

        // Apply the move. Defense-in-depth: re-scope by client_id
        // so a future regression in the ownership SELECT above can't
        // shift another tenant's booking. Reset the reminders_sent
        // map so reminders fire correctly against the new datetime.
        const updated = await sql.query(
          `UPDATE bookings SET
             date            = $3::date,
             start_min       = $4,
             end_min         = $5,
             reminders_sent  = '{}'::jsonb,
             sms_sent        = '{}'::jsonb
           WHERE id = $1 AND client_id = ANY($2)
           RETURNING *`,
          [id, myIds, newDate, newStart, newEnd],
        );
        await postRescheduleNote({
          workspaceId: booking.workspace_id,
          clientId: booking.client_id,
          booking,
          newDate, newStart, newEnd,
        });
        // Push the move into the owner's connected Google Calendar.
        syncOnBookingUpdated({ workspaceId: booking.workspace_id, bookingId: id });
        return ok(res, { booking: serializeBooking(updated.rows[0]) });
      }

      if (!body.cancelOccurrence) return badRequest(res, 'Provide either rescheduleTo or cancelOccurrence');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.cancelOccurrence)) {
        return badRequest(res, 'cancelOccurrence must be YYYY-MM-DD');
      }
      if (!booking.recurrence_rule) {
        return badRequest(res, 'This booking is not part of a recurring series');
      }
      const updated = await sql.query(
        `UPDATE bookings
         SET cancelled_occurrences = CASE
           WHEN $3::date = ANY(cancelled_occurrences) THEN cancelled_occurrences
           ELSE array_append(cancelled_occurrences, $3::date)
         END
         WHERE id = $1 AND client_id = ANY($2)
         RETURNING *`,
        [id, myIds, body.cancelOccurrence],
      );
      await postCancellationNote({
        workspaceId: booking.workspace_id,
        clientId: booking.client_id,
        booking,
        occurrenceDate: body.cancelOccurrence,
      });
      // Updated EXDATE list → push to Google so the cancelled occurrence
      // also drops out of the user's connected calendar.
      syncOnBookingUpdated({ workspaceId: booking.workspace_id, bookingId: id });
      return ok(res, { booking: serializeBooking(updated.rows[0]) });
    }

    return methodNotAllowed(res, ['DELETE', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}

async function postRescheduleNote({ workspaceId, clientId, booking, newDate, newStart, newEnd }) {
  try {
    const oldDate = booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : booking.date;
    const note = `📅 Client moved the booking from ${oldDate} ${fmtTime(booking.start_min)} to ${newDate} ${fmtTime(newStart)}–${fmtTime(newEnd)}.`;
    const tIns = await sql`
      INSERT INTO message_threads (workspace_id, client_id)
      VALUES (${workspaceId}, ${clientId})
      ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
      RETURNING id
    `;
    const threadId = tIns.rows[0].id;
    await sql`
      INSERT INTO messages (thread_id, sender, text, kind, meta)
      VALUES (${threadId}, 'system', ${note}, 'reschedule',
              ${JSON.stringify({ bookingId: booking.id, oldDate, oldStart: booking.start_min, newDate, newStart, newEnd })}::jsonb)
    `;
    await sql`
      UPDATE message_threads SET
        last_message_at = NOW(),
        last_message_preview = ${note.slice(0, 200)},
        unread_biz = unread_biz + 1
      WHERE id = ${threadId} AND workspace_id = ${workspaceId}
    `;
  } catch {
    // Best-effort.
  }
}

async function postCancellationNote({ workspaceId, clientId, booking, occurrenceDate }) {
  try {
    const dateISO = occurrenceDate
      || (booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : booking.date);
    const note = `❌ Client cancelled the booking on ${dateISO} at ${fmtTime(booking.start_min)}.`;
    const tIns = await sql`
      INSERT INTO message_threads (workspace_id, client_id)
      VALUES (${workspaceId}, ${clientId})
      ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
      RETURNING id
    `;
    const threadId = tIns.rows[0].id;
    await sql`
      INSERT INTO messages (thread_id, sender, text, kind, meta)
      VALUES (${threadId}, 'system', ${note}, 'cancellation', ${JSON.stringify({ bookingId: booking.id, occurrenceDate: occurrenceDate || null })}::jsonb)
    `;
    await sql`
      UPDATE message_threads SET
        last_message_at = NOW(),
        last_message_preview = ${note.slice(0, 200)},
        unread_biz = unread_biz + 1
      WHERE id = ${threadId} AND workspace_id = ${workspaceId}
    `;
  } catch {
    // Best-effort — never fail the cancel because the side-effect threw.
  }
}

function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
