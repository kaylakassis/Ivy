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
import { serializeBooking, hasConflict, losesBookingRace, withinAvailability, slotEpochMs } from '../../_lib/calendar.js';
import { syncOnBookingDeleted, syncOnBookingUpdated, syncOnBookingCreated } from '../../_lib/googleSync.js';
import { restoreCredit } from '../../_lib/packages.js';
import { restoreGiftCardCreditForBooking } from '../../_lib/giftCards.js';
import { promoteWaitlistOnCancel } from '../../_lib/waitlist.js';
import { notifyNewBooking, notifyBookingCancellation, notifyBookingRescheduled } from '../../_lib/bookingNotify.js';
import { attachIntakeForms } from '../../_lib/intake.js';
import { loadStripeCreds } from '../../_lib/stripeCreds.js';
import { chargeOffSession } from '../../_lib/stripe.js';

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
      // Delivered sessions are not cancellable: a completed or no-show
      // booking (or one whose date already passed) must not restore
      // package credits or fire cancellation flows.
      if (booking.no_show_at) return badRequest(res, 'This session was marked as a no-show - contact the business if that seems wrong.');
      if (booking.completion_log && Object.keys(booking.completion_log || {}).length > 0) {
        return badRequest(res, 'This session was already completed and can no longer be cancelled.');
      }
      if (booking.date && String(booking.date).slice(0, 10) < new Date().toISOString().slice(0, 10)) {
        return badRequest(res, 'This session date has already passed - contact the business directly.');
      }

      // Late-cancel auto-charge. If the booking starts within the
      // service's cancellation_window_hours AND a fee is configured AND
      // there's a saved card on file, charge the fee off-session. The
      // cancel itself goes through whether the charge succeeds or not
      // (so a declined card doesn't trap the client in a session they
      // can't make).
      let lateCancelCharged = null;
      let lateCancelChargeError = null;
      try {
        const policy = await maybeChargeLateCancel({
          booking, myIds,
        });
        lateCancelCharged = policy.charged;
        lateCancelChargeError = policy.error;
      } catch {
        // Logged inside helper. Don't block the cancel.
      }

      // Soft-cancel. Defense-in-depth: include client_id IN (...) on the
      // UPDATE so a future regression in the ownership check above can't
      // cancel another tenant's booking. When a late-cancel fee was
      // charged, persist the charge fields in the same UPDATE so we
      // don't have a window where the booking is cancelled-but-no-fee.
      let cancelRes;
      if (lateCancelCharged) {
        cancelRes = await sql.query(
          `UPDATE bookings SET
             cancelled_at       = NOW(),
             fee_charged_amount = $3,
             fee_charged_at     = NOW(),
             fee_charged_kind   = 'late_cancel',
             fee_payment_intent = $4
           WHERE id = $1 AND client_id = ANY($2) AND cancelled_at IS NULL`,
          [id, myIds, lateCancelCharged.amount, lateCancelCharged.paymentIntent],
        );
      } else {
        cancelRes = await sql.query(
          `UPDATE bookings SET cancelled_at = NOW()
           WHERE id = $1 AND client_id = ANY($2) AND cancelled_at IS NULL`,
          [id, myIds],
        );
      }
      // Lost a race with a concurrent cancel: the other request already
      // ran the side effects (credit restore, waitlist promotion, notes).
      // Running them again would restore the package credit TWICE.
      if ((cancelRes.rowCount || 0) === 0) {
        return ok(res, { cancelled: true, deduped: true });
      }
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
      // Refund any consumed package credit.
      await restoreCredit({ workspaceId: booking.workspace_id, clientPackageId: booking.client_package_id });
      // Put any gift-card credit back on the card (exactly-once inside).
      await restoreGiftCardCreditForBooking({ workspaceId: booking.workspace_id, bookingId: booking.id })
        .catch((err) => console.error('[portal cancel] gift card restore failed:', err.message));
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
      // Return JSON instead of 204 so the UI can surface "fee charged"
      // / "fee couldn't be charged" inline. Falls back to ok({}) when
      // no fee was applied so older clients keep working.
      return ok(res, {
        cancelled: true,
        feeCharged: lateCancelCharged ? lateCancelCharged.amount : 0,
        feeChargeError: lateCancelChargeError,
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
        if (booking.cancelled_at) return badRequest(res, "Can't reschedule a cancelled booking");
        if (booking.recurrence_rule) {
          return badRequest(res, 'Recurring bookings can\'t be rescheduled - cancel this occurrence and book a new one.');
        }
        // Same delivered-session guards as cancel.
        if (booking.no_show_at) return badRequest(res, 'This session was marked as a no-show - contact the business if that seems wrong.');
        if (booking.completion_log && Object.keys(booking.completion_log || {}).length > 0) {
          return badRequest(res, 'This session was already completed and can no longer be rescheduled.');
        }
        if (booking.date && String(booking.date).slice(0, 10) < new Date().toISOString().slice(0, 10)) {
          return badRequest(res, 'This session date has already passed - contact the business directly.');
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
             sms_sent        = '{}'::jsonb
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

// If the booking is being cancelled inside the service's
// cancellation_window_hours AND the service has a non-zero fee AND
// the client has a card on file, charge the fee off-session. Returns
// { charged, error } where charged is { amount, paymentIntent } on
// success or null when nothing was charged. Never throws - the cancel
// must always go through.
async function maybeChargeLateCancel({ booking, myIds }) {
  try {
    if (!booking.client_id) return { charged: null, error: null };
    const r = await sql.query(
      `SELECT s.cancellation_fee_amount, s.cancellation_window_hours, s.name AS service_name,
              c.stripe_customer_id, c.payment_method_id
         FROM clients c
         LEFT JOIN services s ON s.id = $2 AND s.workspace_id = c.workspace_id
        WHERE c.id = $1 AND c.id = ANY($3)
        LIMIT 1`,
      [booking.client_id, booking.service_id, myIds],
    );
    const row = r.rows[0];
    if (!row) return { charged: null, error: null };
    const feeAmount = Number(row.cancellation_fee_amount || 0);
    const windowHours = Number(row.cancellation_window_hours || 0);
    if (feeAmount <= 0 || windowHours <= 0) return { charged: null, error: null };
    if (!row.stripe_customer_id || !row.payment_method_id) return { charged: null, error: null };

    // "Inside the window" = booking starts before NOW + windowHours.
    // The (date, start_min) pair is wall-clock in the workspace timezone,
    // so the UTC epoch we compare against has to honor that tz - otherwise
    // a non-UTC owner sees cancellation-fee math drift by several hours
    // (same root cause as the public-booking notice-window bug).
    const dateISO = booking.date instanceof Date
      ? booking.date.toISOString().slice(0, 10)
      : booking.date;
    const tzRow = await sql`SELECT timezone FROM calendar_settings WHERE workspace_id = ${booking.workspace_id}`;
    const workspaceTz = tzRow.rows[0]?.timezone || null;
    const startMs = slotEpochMs(dateISO, booking.start_min, workspaceTz);
    const cutoffMs = Date.now() + windowHours * 60 * 60 * 1000;
    if (startMs >= cutoffMs) return { charged: null, error: null }; // outside window - free cancel

    const creds = await loadStripeCreds(booking.workspace_id);
    const pi = await chargeOffSession({
      secretKey: creds.secretKey,

      stripeAccount: creds.stripeAccount,
      customerId: row.stripe_customer_id,
      paymentMethodId: row.payment_method_id,
      amountCents: Math.round(feeAmount * 100),
      currency: creds.currency,
      description: `Late-cancel fee - ${row.service_name || 'session'}`,
      metadata: { booking_id: booking.id, workspace_id: booking.workspace_id, kind: 'late_cancel' },
      statementDescriptor: 'LATE CANCEL FEE',
      // Shares the `fee-<booking>` key so a late-cancel fee can't be
      // double-charged on retry / crash-after-charge.
      idempotencyKey: `fee-${booking.id}`,
    });
    return {
      charged: { amount: feeAmount, paymentIntent: pi.id },
      error: null,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[late-cancel charge] failed:', err.message);
    return { charged: null, error: err.message || 'charge failed' };
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
    // Best-effort - never fail the cancel because the side-effect threw.
  }
}

function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
