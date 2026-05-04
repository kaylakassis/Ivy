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
import { serializeBooking } from '../../_lib/calendar.js';

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
      return noContent(res);
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (!body.cancelOccurrence) return badRequest(res, 'Only cancelOccurrence is supported');
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
      return ok(res, { booking: serializeBooking(updated.rows[0]) });
    }

    return methodNotAllowed(res, ['DELETE', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
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
