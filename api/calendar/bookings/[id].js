// /api/calendar/bookings/:id
//   PATCH  → edit fields (notes, recurrence rule, etc.), cancel a single
//            occurrence by passing { cancelOccurrence: 'YYYY-MM-DD' }, OR
//            reschedule by passing { rescheduleTo: { date, startMin, endMin } }
//   DELETE → soft-cancel the entire booking (and its series if recurring)
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { serializeBooking, hasConflict, losesBookingRace, withinAvailability, VALID_RECURRENCE } from '../../_lib/calendar.js';
import { syncOnBookingUpdated, syncOnBookingDeleted, syncOnBookingCreated } from '../../_lib/googleSync.js';
import { restoreCredit } from '../../_lib/packages.js';
import { promoteWaitlistOnCancel } from '../../_lib/waitlist.js';
import { notifyNewBooking, notifyBookingCancellation, notifyBookingRescheduled } from '../../_lib/bookingNotify.js';
import { attachIntakeForms } from '../../_lib/intake.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';
import { requireSameOrigin } from "../../_lib/security.js";

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    const found = await sql`
      SELECT * FROM bookings WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
    if (found.rows.length === 0) return notFound(res, 'Booking not found');

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const booking = found.rows[0];

      // Reschedule path: { rescheduleTo: { date, startMin, endMin } }
      // — owner moves a booking to a new slot. Mirrors the client-portal
      // path at /api/me/bookings/[id].js so audit-trail (booking id),
      // package credits, and Google Calendar sync are preserved.
      // Recurring series can't be rescheduled — owner cancels the
      // occurrence + books a new one, same as the client portal.
      if (body.rescheduleTo && typeof body.rescheduleTo === 'object') {
        if (booking.cancelled_at) return badRequest(res, "Can't reschedule a cancelled booking");
        if (booking.recurrence_rule) {
          return badRequest(res, "Recurring bookings can't be rescheduled — cancel this occurrence and book a new one.");
        }
        const r = body.rescheduleTo;
        const newDate  = (r.date || '').toString();
        const newStart = Number(r.startMin);
        const newEnd   = Number(r.endMin);
        const skipAvailability = !!r.skipAvailabilityCheck;
        const skipConflict     = !!r.skipConflictCheck;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return badRequest(res, 'rescheduleTo.date must be YYYY-MM-DD');
        if (!Number.isInteger(newStart) || newStart < 0 || newStart >= 24 * 60) {
          return badRequest(res, 'rescheduleTo.startMin out of range');
        }
        if (!Number.isInteger(newEnd) || newEnd <= newStart || newEnd > 24 * 60) {
          return badRequest(res, 'rescheduleTo.endMin out of range');
        }
        // Owner can move into the past for legitimate cases (recording a
        // walk-in after the fact). Block "obvious typo" past dates +
        // past times-on-today unless the owner explicitly opts in. The
        // today+past-time guard catches the realistic mistake of typing
        // 9am when you meant 9pm and it's already noon.
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const nowMins = now.getUTCHours() * 60 + now.getUTCMinutes();
        if (!r.allowPast) {
          if (newDate < today) {
            return badRequest(res, "That's in the past — pass allowPast: true to record a historical session.");
          }
          if (newDate === today && newEnd <= nowMins) {
            return badRequest(res, "That time has already passed today — pass allowPast: true to record a historical session.");
          }
        }

        // Fetch the booking's service first so we can apply its per-service
        // availability override (if any) to the availability check below.
        let capacity = 1;
        let serviceAvailability = null;
        if (booking.service_id) {
          const sv = await sql`
            SELECT capacity, availability FROM services WHERE id = ${booking.service_id} AND workspace_id = ${workspaceId}
          `;
          if (sv.rows[0]?.capacity) capacity = Number(sv.rows[0].capacity);
          serviceAvailability = sv.rows[0]?.availability || null;
        }

        // Availability check — getUTCDay() to match other booking paths.
        // Owner can override via skipAvailabilityCheck for off-hours
        // bookings (e.g. a Sunday session when normal hours are
        // Mon–Sat). Conflict check the same way.
        if (!skipAvailability) {
          const cs = await sql`
            SELECT availability FROM calendar_settings WHERE workspace_id = ${workspaceId}
          `;
          const availability = cs.rows[0]?.availability || {};
          const weekday = new Date(newDate + 'T00:00:00Z').getUTCDay();
          if (!withinAvailability(availability, weekday, newStart, newEnd, serviceAvailability)) {
            return badRequest(res, serviceAvailability
              ? "That time isn't in this service’s available hours — toggle Override to book anyway"
              : "That time isn't in your available hours — toggle Override to book anyway");
          }
        }

        if (!skipConflict) {
          const conflict = await hasConflict({
            workspaceId,
            dateISO: newDate,
            start: newStart,
            end: newEnd,
            serviceId: booking.service_id,
            capacity,
            excludeBookingId: booking.id,
          });
          if (conflict) {
            return badRequest(res, capacity > 1
              ? 'That class is full or the slot conflicts with another booking'
              : 'That slot conflicts with an existing booking or block');
          }
        }

        // Apply the move + reset reminders_sent / sms_sent so reminders
        // fire correctly against the new datetime (same as the client
        // path).
        const updated = await sql`
          UPDATE bookings SET
            date            = ${newDate}::date,
            start_min       = ${newStart},
            end_min         = ${newEnd},
            reminders_sent  = '{}'::jsonb,
            sms_sent        = '{}'::jsonb,
            updated_at      = NOW()
          WHERE id = ${id} AND workspace_id = ${workspaceId}
          RETURNING *
        `;

        // Optimistic double-booking resolution. hasConflict above is a
        // check-then-act, so two concurrent reschedules (or a reschedule
        // racing a fresh booking) into the same slot can both pass it.
        // Now that the move is committed, yield if enough conflicting
        // bookings rank before us — and on loss REVERT to the old slot
        // (unlike a create, the row must survive at its prior time).
        if (!skipConflict) {
          const lost = await losesBookingRace({
            workspaceId, dateISO: newDate, start: newStart, end: newEnd,
            serviceId: booking.service_id, capacity,
            bookingId: booking.id, createdAt: updated.rows[0].created_at,
          }).catch((e) => {
            // eslint-disable-next-line no-console
            console.error('[bookings reschedule] race recheck failed; keeping move:', e.message);
            return false;
          });
          if (lost) {
            const oldDateISO = booking.date instanceof Date
              ? booking.date.toISOString().slice(0, 10) : booking.date;
            await sql`
              UPDATE bookings SET
                date = ${oldDateISO}::date, start_min = ${booking.start_min},
                end_min = ${booking.end_min}, updated_at = NOW()
              WHERE id = ${id} AND workspace_id = ${workspaceId}
            `.catch(() => {});
            return badRequest(res, capacity > 1
              ? 'That class is full or the slot conflicts with another booking'
              : 'That slot was just taken — please pick another time');
          }
        }

        syncOnBookingUpdated({ workspaceId, bookingId: id });
        // Fire-and-forget client notification with old slot in the
        // "Was: ..." line. source='owner' so the email greeting
        // reflects who initiated the move.
        notifyBookingRescheduled({
          workspaceId, bookingId: booking.id,
          oldDateISO:  booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : booking.date,
          oldStartMin: booking.start_min,
          oldEndMin:   booking.end_min,
          source: 'owner',
        });
        return ok(res, { booking: serializeBooking(updated.rows[0]) });
      }

      // Convenience: cancel a single occurrence in a recurring series.
      if (body.cancelOccurrence) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.cancelOccurrence)) {
          return badRequest(res, 'cancelOccurrence must be YYYY-MM-DD');
        }
        const updated = await sql`
          UPDATE bookings
          SET cancelled_occurrences = CASE
            WHEN ${body.cancelOccurrence}::date = ANY(cancelled_occurrences) THEN cancelled_occurrences
            ELSE array_append(cancelled_occurrences, ${body.cancelOccurrence}::date)
          END
          WHERE id = ${id} AND workspace_id = ${workspaceId}
          RETURNING *
        `;
        syncOnBookingUpdated({ workspaceId, bookingId: id });
        // Fire-and-forget notification — owner is cancelling on behalf
        // of the recurring series, so source='owner'.
        notifyBookingCancellation({
          workspaceId, bookingId: id,
          occurrenceDate: body.cancelOccurrence, source: 'owner',
        });
        return ok(res, { booking: serializeBooking(updated.rows[0]) });
      }

      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('notes' in body)            push('notes', body.notes == null ? null : String(body.notes).slice(0, 4000));
      if ('recurrenceRule' in body) {
        if (!VALID_RECURRENCE.has(body.recurrenceRule)) return badRequest(res, 'Invalid recurrence rule');
        push('recurrence_rule', body.recurrenceRule);
      }
      if ('recurrenceUntil' in body) {
        if (body.recurrenceUntil && !/^\d{4}-\d{2}-\d{2}$/.test(body.recurrenceUntil)) {
          return badRequest(res, 'recurrenceUntil must be YYYY-MM-DD');
        }
        push('recurrence_until', body.recurrenceUntil || null);
      }
      if ('staffId' in body) {
        const sid = body.staffId ? String(body.staffId) : null;
        if (sid) {
          // eslint-disable-next-line no-await-in-loop
          const st = await sql`
            SELECT id FROM staff_members
             WHERE id = ${sid} AND workspace_id = ${workspaceId} AND active = TRUE
          `;
          if (st.rows.length === 0) return badRequest(res, 'Unknown or inactive staff member');
        }
        push('staff_id', sid);
      }

      if (sets.length === 0) return ok(res, { booking: serializeBooking(found.rows[0]) });

      values.push(id, workspaceId);
      const queryText = `
        UPDATE bookings SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      let rows;
      try {
        ({ rows } = await sql.query(queryText, values));
      } catch (e) {
        if (/staff_id.*does not exist|column .* does not exist/i.test(e.message || '')) {
          // Self-heal: a recently-added column (staff_id, or anything
          // similar) hasn't landed in the user's DB yet. Add it and
          // retry once before bubbling up.
          // eslint-disable-next-line no-console
          console.error('[bookings PATCH] column missing; self-healing and retrying:', e.message);
          try { await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS staff_id UUID`; } catch {}
          ({ rows } = await sql.query(queryText, values));
        } else { throw e; }
      }
      syncOnBookingUpdated({ workspaceId, bookingId: id });
      return ok(res, { booking: serializeBooking(rows[0]) });
    }

    if (req.method === 'DELETE') {
      const r = await sql`
        UPDATE bookings SET cancelled_at = NOW()
        WHERE id = ${id} AND workspace_id = ${workspaceId} AND cancelled_at IS NULL
      `;
      if (r.rowCount === 0) return notFound(res, 'Booking not found or already cancelled');
      const cancelled = found.rows[0];
      syncOnBookingDeleted({ workspaceId, googleEventId: cancelled.google_event_id });
      // Fire-and-forget cancellation email/push (owner-initiated).
      notifyBookingCancellation({ workspaceId, bookingId: id, source: 'owner' });
      // Refund the package credit if this booking consumed one.
      await restoreCredit({ workspaceId, clientPackageId: cancelled.client_package_id });
      // Promote next waitlist entry into a real booking. Best-effort —
      // any failure logs but doesn't fail the cancel.
      try {
        const promoted = await promoteWaitlistOnCancel({
          workspaceId,
          serviceId: cancelled.service_id,
          dateISO:   cancelled.date,
          startMin:  cancelled.start_min,
          endMin:    cancelled.end_min,
        });
        if (promoted) {
          notifyNewBooking({ workspaceId, bookingId: promoted.id, source: 'waitlist' });
          syncOnBookingCreated({ workspaceId, bookingId: promoted.id });
          attachIntakeForms({ workspaceId, bookingId: promoted.id });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[waitlist] promote failed on cancel:', err.message);
      }
      return noContent(res);
    }

    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
