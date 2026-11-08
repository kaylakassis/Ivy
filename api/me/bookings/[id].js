// DELETE /api/me/bookings/:id - client cancels their own booking.
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
import { serializeBooking, hasConflict, losesBookingRace, withinAvailability, slotEpochMs, workspaceTimeZone } from '../../_lib/calendar.js';
import { syncOnBookingDeleted, syncOnBookingUpdated } from '../../_lib/googleSync.js';
import { restoreCredit } from '../../_lib/packages.js';
import { restoreGiftCardCreditForBooking } from '../../_lib/giftCards.js';
import { fillFromWaitlistOnCancel } from '../../_lib/waitlist.js';
import { notifyBookingCancellation, notifyBookingRescheduled } from '../../_lib/bookingNotify.js';
import { isPendingRequest, cancelBookingRequestByClient } from '../../_lib/bookingRequests.js';
import { settleClientCancellation, describeClientCancellation } from '../../_lib/bookingFees.js';
import { archivedForbidden } from '../../_lib/businessAccess.js';

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
      // 1.0.6: withdrawing a booking request. Nothing was charged, so there
      // is no fee or refund; the business is told and the time opens up.
      if (isPendingRequest(booking)) {
        const out = await cancelBookingRequestByClient({ workspaceId: booking.workspace_id, bookingId: booking.id, clientIds: myIds });
        if (out.alreadyDecided) return ok(res, { cancelled: true, deduped: true, request: true });
        return ok(res, { cancelled: true, request: true, policyMessage: null });
      }
      // Delivered sessions are not cancellable: a completed or no-show
      // booking (or one whose date already passed) must not restore
      // package credits or fire cancellation flows.
      if (booking.no_show_at) return badRequest(res, 'This session was marked as a no-show - contact the business if that seems wrong.');
      if (booking.completion_log && Object.keys(booking.completion_log || {}).length > 0) {
        return badRequest(res, 'This session was already completed and can no longer be cancelled.');
      }
      if (await sessionStarted(booking)) {
        return badRequest(res, 'This session date has already passed - contact the business directly.');
      }

      // Soft-cancel first. Defense-in-depth: include client_id IN (...) on
      // the UPDATE so a future regression in the ownership check above
      // can't cancel another tenant's booking. Only the request that wins
      // this UPDATE settles money (deposit refund / late-cancel fee), so a
      // double tap can never charge or refund twice. The cancel always
      // goes through, even if the card is declined.
      const cancelRes = await sql.query(
        `UPDATE bookings SET cancelled_at = NOW(), cancelled_by = 'client'
         WHERE id = $1 AND client_id = ANY($2) AND cancelled_at IS NULL`,
        [id, myIds],
      );
      // Lost a race with a concurrent cancel: the other request already
      // ran the side effects (credit restore, waitlist promotion, notes).
      // Running them again would restore the package credit TWICE.
      if ((cancelRes.rowCount || 0) === 0) {
        return ok(res, { cancelled: true, deduped: true });
      }
      // Cancellation policy money (api/_lib/bookingFees.js): before the
      // window the deposit is refunded; inside it the deposit is kept and
      // only the rest of the late-cancel fee goes on the saved card.
      //
      // Package sessions (agreed rule, api/_lib/bookingFees.js): a business
      // that uses sessions when booked keeps the session used for a late
      // cancel INSTEAD of charging a fee (never both); in time, the session
      // comes back. A business that uses sessions on completion only held
      // the session, so it always comes back and the normal late fee
      // applies. If settling fails the session goes back (client-friendly).
      let settled = null;
      try {
        settled = await settleClientCancellation({ workspaceId: booking.workspace_id, bookingId: booking.id });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[portal cancel] cancellation policy settle failed:', err.message);
      }
      const packageKept = !!settled?.packageSessionKept;
      // Drop a system note in the thread so the business sees the cancellation.
      await postCancellationNote({
        workspaceId: booking.workspace_id,
        clientId: booking.client_id,
        booking,
      });
      syncOnBookingDeleted({ workspaceId: booking.workspace_id, googleEventId: booking.google_event_id });
      // Fire-and-forget email/push notification to the owner.
      notifyBookingCancellation({
        workspaceId: booking.workspace_id, bookingId: booking.id, source: 'client',
      });
      // Give the package session back, unless this was a late cancel
      // under the business's policy (see packageKept above).
      if (!packageKept) {
        await restoreCredit({ workspaceId: booking.workspace_id, clientPackageId: booking.client_package_id });
      }
      // Put any gift-card credit back on the card (exactly-once inside).
      await restoreGiftCardCreditForBooking({ workspaceId: booking.workspace_id, bookingId: booking.id })
        .catch((err) => console.error('[portal cancel] gift card restore failed:', err.message));
      // Offer the freed time to the waitlist (one-tap claim link). Best-effort.
      try {
        await fillFromWaitlistOnCancel({
          workspaceId: booking.workspace_id,
          serviceId: booking.service_id,
          dateISO:   booking.date,
          startMin:  booking.start_min,
          endMin:    booking.end_min,
          sourceBookingId: booking.id,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[waitlist] offer failed on cancel:', err.message);
      }
      // Return JSON instead of 204 so the UI can surface "fee charged"
      // / "fee couldn't be charged" inline. Falls back to ok({}) when
      // no fee was applied so older clients keep working.
      return ok(res, {
        cancelled: true,
        feeCharged: settled ? settled.feeChargedCents / 100 : 0,
        feeChargeError: settled?.feeError || null,
        // 1.0.5+: the deposit side and a plain sentence for the client.
        depositRefunded: settled ? settled.depositRefundedCents / 100 : 0,
        depositKept: settled ? settled.depositKeptCents / 100 : 0,
        feeFromDeposit: settled ? settled.feeFromDepositCents / 100 : 0,
        policyMessage: describeClientCancellation(settled),
        // Package bookings: whether the session went back into the package.
        ...(booking.client_package_id ? { packageSessionReturned: !packageKept } : {}),
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);

      // Reschedule path: { rescheduleTo: { date, startMin, endMin } }
      // - moves the booking to a new slot. Server-validates against the
      // workspace's availability + active bookings, including a
      // self-exclusion so the booking's own current slot doesn't count
      // as a conflict if the user re-picks the same slot.
      if (body.rescheduleTo && typeof body.rescheduleTo === 'object') {
        // Business no longer on Ivy: a reschedule is a new slot with an
        // archived business. Cancelling (DELETE above) still works.
        const membership = memberships.find((m) => m.clientId === booking.client_id);
        if (membership?.archived) return archivedForbidden(res);
        if (booking.cancelled_at) return badRequest(res, "Can't reschedule a cancelled booking");
        if (isPendingRequest(booking)) return badRequest(res, 'This time is still waiting for the business to confirm. Cancel the request and request another time instead.');
        if (booking.recurrence_rule) {
          return badRequest(res, 'Recurring bookings can\'t be rescheduled - cancel this occurrence and book a new one.');
        }
        // Same delivered-session guards as cancel.
        if (booking.no_show_at) return badRequest(res, 'This session was marked as a no-show - contact the business if that seems wrong.');
        if (booking.completion_log && Object.keys(booking.completion_log || {}).length > 0) {
          return badRequest(res, 'This session was already completed and can no longer be rescheduled.');
        }
        if (await sessionStarted(booking)) {
          return badRequest(res, 'This session date has already passed - contact the business directly.');
        }
        const r = body.rescheduleTo;
        const newDate  = (r.date || '').toString();
        const newStart = Number(r.startMin);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return badRequest(res, 'rescheduleTo.date must be YYYY-MM-DD');
        if (!Number.isInteger(newStart) || newStart < 0 || newStart >= 24 * 60) {
          return badRequest(res, 'rescheduleTo.startMin out of range');
        }
        // A reschedule moves the session; it never changes how long it is.
        // The end time is derived from the booking's own duration, so a
        // client cannot stretch one slot across the whole day.
        const durationMin = Math.max(5, Number(booking.end_min) - Number(booking.start_min) || 60);
        const newEnd = newStart + durationMin;
        if (newEnd > 24 * 60) return badRequest(res, 'That start time runs past the end of the day');
        if (r.endMin != null && Number(r.endMin) !== newEnd) {
          return badRequest(res, 'A session keeps its length when rescheduled');
        }
        const today = new Date().toISOString().slice(0, 10);
        if (newDate < today) return badRequest(res, "Can't reschedule into the past");

        // Pull the workspace's availability + the service's capacity
        // and per-service availability override for conflict-checking.
        // If the service was deleted (orphan booking), default capacity
        // to 1 and skip the service-availability narrow.
        const cs = await sql`
          SELECT availability, buffer_minutes, timezone FROM calendar_settings WHERE workspace_id = ${booking.workspace_id}
        `;
        const availability = cs.rows[0]?.availability || {};
        const bufferMin = Math.max(0, Number(cs.rows[0]?.buffer_minutes || 0));
        const workspaceTz = cs.rows[0]?.timezone || null;

        let capacity = 1;
        let serviceAvailability = null;
        let cancelFee = 0;
        let cancelWindowHours = 0;
        if (booking.service_id) {
          const sv = await sql`
            SELECT capacity, availability, cancellation_fee_amount, cancellation_window_hours
              FROM services WHERE id = ${booking.service_id} AND workspace_id = ${booking.workspace_id}
          `;
          if (sv.rows[0]?.capacity) capacity = Number(sv.rows[0].capacity);
          serviceAvailability = sv.rows[0]?.availability || null;
          cancelFee = Number(sv.rows[0]?.cancellation_fee_amount || 0);
          cancelWindowHours = Number(sv.rows[0]?.cancellation_window_hours || 0);
        }

        // Cancellation-window policy applies to reschedules too: once the
        // CURRENT slot is inside the fee window, moving it out for free
        // would dodge the late-cancel fee (reschedule-then-cancel loophole).
        if (cancelFee > 0 && cancelWindowHours > 0) {
          const curDateISO = booking.date instanceof Date
            ? booking.date.toISOString().slice(0, 10) : booking.date;
          const curStartMs = slotEpochMs(curDateISO, booking.start_min, workspaceTz);
          if (curStartMs < Date.now() + cancelWindowHours * 60 * 60 * 1000) {
            return badRequest(res, `This session starts within the ${cancelWindowHours}-hour cancellation window and can't be rescheduled online anymore - contact the business directly.`);
          }
        }

        // getUTCDay() (not getDay()) - matches the other booking paths
        // so a workspace in a non-UTC timezone doesn't see day-of-week
        // drift around midnight UTC.
        const weekday = new Date(newDate + 'T00:00:00Z').getUTCDay();
        if (!withinAvailability(availability, weekday, newStart, newEnd, serviceAvailability)) {
          return badRequest(res, serviceAvailability
            ? "That time isn't in this service's available hours."
            : "That time isn't in the business's available hours.");
        }

        const conflict = await hasConflict({
          workspaceId: booking.workspace_id,
          dateISO: newDate,
          start: newStart,
          end: newEnd,
          serviceId: booking.service_id,
          capacity,
          excludeBookingId: booking.id,
          bufferMin,
        });
        if (conflict) return badRequest(res, 'That slot is no longer available - pick another time.');

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
             sms_sent        = '{}'::jsonb,
             push_sent       = '{}'::jsonb,
             owner_reminders_sent = '{}'::jsonb
           WHERE id = $1 AND client_id = ANY($2)
           RETURNING *`,
          [id, myIds, newDate, newStart, newEnd],
        );

        // Optimistic double-booking resolution (see losesBookingRace).
        // hasConflict above is check-then-act; on a lost race REVERT to
        // the old slot rather than deleting the client's booking.
        const lostRace = await losesBookingRace({
          workspaceId: booking.workspace_id, dateISO: newDate,
          start: newStart, end: newEnd, serviceId: booking.service_id,
          capacity, bookingId: booking.id, createdAt: updated.rows[0].created_at,
          bufferMin,
        }).catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[me/bookings reschedule] race recheck failed; keeping move:', e.message);
          return false;
        });
        if (lostRace) {
          const oldDateISO = booking.date instanceof Date
            ? booking.date.toISOString().slice(0, 10) : booking.date;
          await sql.query(
            `UPDATE bookings SET date = $3::date, start_min = $4, end_min = $5
               WHERE id = $1 AND client_id = ANY($2)`,
            [id, myIds, oldDateISO, booking.start_min, booking.end_min],
          ).catch(() => {});
          return badRequest(res, 'That slot is no longer available - pick another time.');
        }

        await postRescheduleNote({
          workspaceId: booking.workspace_id,
          clientId: booking.client_id,
          booking,
          newDate, newStart, newEnd,
        });
        // Push the move into the owner's connected Google Calendar.
        syncOnBookingUpdated({ workspaceId: booking.workspace_id, bookingId: id });
        // Fire-and-forget reschedule email/push to owner. Client kept
        // the old slot's date/time before update; capture for the
        // "Was: ..." line in the email.
        notifyBookingRescheduled({
          workspaceId: booking.workspace_id, bookingId: booking.id,
          oldDateISO:   booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : booking.date,
          oldStartMin:  booking.start_min,
          oldEndMin:    booking.end_min,
          source: 'client',
        });
        return ok(res, { booking: serializeBooking(updated.rows[0]) });
      }

      if (!body.cancelOccurrence) return badRequest(res, 'Provide either rescheduleTo or cancelOccurrence');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.cancelOccurrence)) {
        return badRequest(res, 'cancelOccurrence must be YYYY-MM-DD');
      }
      if (!booking.recurrence_rule) {
        return badRequest(res, 'This booking is not part of a recurring series');
      }
      // Same window rule as reschedule: a single occurrence inside the
      // late-cancel window can't be dropped online for free (fees are
      // charged once per booking, so an occurrence fee has to go through
      // the business).
      if (await occurrenceInsideFeeWindow(booking, body.cancelOccurrence)) {
        return badRequest(res, 'This session starts within the cancellation window and can\'t be cancelled online anymore - contact the business directly.');
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

// True once the appointment's start time (in the business's time zone)
// has passed. The old check compared the booking date with today's UTC
// date, which blocked evening cancellations in US time zones (after
// 4-5 PM Pacific it is already tomorrow in UTC).
async function occurrenceInsideFeeWindow(booking, dateISO) {
  if (!booking.service_id) return false;
  const sv = await sql`
    SELECT cancellation_fee_amount, cancellation_window_hours FROM services
     WHERE id = ${booking.service_id} AND workspace_id = ${booking.workspace_id}
  `;
  const fee = Number(sv.rows[0]?.cancellation_fee_amount || 0);
  const hours = Number(sv.rows[0]?.cancellation_window_hours || 0);
  if (fee <= 0 || hours <= 0) return false;
  const tz = await workspaceTimeZone(booking.workspace_id);
  const startMs = slotEpochMs(dateISO, Number(booking.start_min) || 0, tz);
  return Number.isFinite(startMs) && startMs < Date.now() + hours * 3_600_000;
}

// True when cancelling now is "late" under a policy the business chose:
// the service has a late-cancel fee AND a free-cancel window, and the
// booking starts inside that window (workspace time zone). Shared by the
// portal (to warn before cancelling) through the same numbers the
// bookings list sends: cancellationFeeAmount / cancellationWindowHours.
export async function isLateCancelWithPolicy(booking, now = Date.now()) {
  if (!booking.service_id) return false;
  const r = await sql`
    SELECT s.cancellation_fee_amount, s.cancellation_window_hours, cs.timezone
      FROM services s
      LEFT JOIN calendar_settings cs ON cs.workspace_id = s.workspace_id
     WHERE s.id = ${booking.service_id} AND s.workspace_id = ${booking.workspace_id}
  `;
  const row = r.rows[0];
  if (!row) return false;
  const fee = Number(row.cancellation_fee_amount || 0);
  const windowHours = Number(row.cancellation_window_hours || 0);
  if (fee <= 0 || windowHours <= 0) return false;
  const dateISO = booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : booking.date;
  const startMs = slotEpochMs(dateISO, booking.start_min, row.timezone || null);
  return startMs < now + windowHours * 60 * 60 * 1000;
}

async function sessionStarted(booking) {
  const dateISO = booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : String(booking.date || '').slice(0, 10);
  if (!dateISO) return false;
  const tz = await workspaceTimeZone(booking.workspace_id);
  const startMs = slotEpochMs(dateISO, Number(booking.start_min) || 0, tz);
  return Number.isFinite(startMs) && startMs <= Date.now();
}

async function postRescheduleNote({ workspaceId, clientId, booking, newDate, newStart, newEnd }) {
  try {
    const oldDate = booking.date instanceof Date ? booking.date.toISOString().slice(0, 10) : booking.date;
    const note = `📅 Client moved the booking from ${oldDate} ${fmtTime(booking.start_min)} to ${newDate} ${fmtTime(newStart)} to ${fmtTime(newEnd)}.`;
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
    // Best-effort - never fail the cancel because the side-effect threw.
  }
}

function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
