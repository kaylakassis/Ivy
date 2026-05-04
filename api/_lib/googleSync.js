// Booking-lifecycle bridge to Google Calendar. Each function is a
// best-effort, fire-and-forget side-effect: a network hiccup with Google
// must never fail the user's primary action (creating a booking, etc.).
//
// Pattern: call the appropriate function from the booking endpoint
// without awaiting (or awaiting inside a try/catch that swallows). The
// schema's bookings.google_event_id is the authoritative pointer; if a
// push fails it just stays NULL and the next update can retry.
import { sql } from './db.js';
import { decrypt } from './secrets.js';
import {
  refreshAccessToken, insertEvent, updateEvent, deleteEvent,
} from './google.js';

// Returns { accessToken, calendarId } when the workspace has Google
// connected, or null if it doesn't (caller skips). Centralised here so
// the per-event helpers don't all repeat the same lookup + decrypt +
// refresh dance.
async function loadConnection(workspaceId) {
  const { rows } = await sql`
    SELECT google_refresh_token_encrypted, google_calendar_id
    FROM calendar_settings
    WHERE workspace_id = ${workspaceId}
  `;
  const r = rows[0];
  if (!r?.google_refresh_token_encrypted || !r?.google_calendar_id) return null;
  let refreshToken;
  try { refreshToken = decrypt(r.google_refresh_token_encrypted); }
  catch { return null; }
  let accessToken;
  try { accessToken = await refreshAccessToken(refreshToken); }
  catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[google-sync] refresh token failed:', err.message);
    return null;
  }
  return { accessToken, calendarId: r.google_calendar_id };
}

async function lookupServiceName(serviceId) {
  if (!serviceId) return null;
  const { rows } = await sql`SELECT name FROM services WHERE id = ${serviceId}`;
  return rows[0]?.name || null;
}

// Push a new booking. Stores the returned event id on bookings so future
// updates can target it. Idempotent on retry: if google_event_id is
// already set, we update instead of insert.
export async function syncOnBookingCreated({ workspaceId, bookingId }) {
  try {
    const conn = await loadConnection(workspaceId);
    if (!conn) return;

    const { rows } = await sql`
      SELECT * FROM bookings WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
    `;
    const booking = rows[0];
    if (!booking || booking.cancelled_at) return;

    const serviceName = await lookupServiceName(booking.service_id);
    if (booking.google_event_id) {
      await updateEvent({
        accessToken: conn.accessToken, calendarId: conn.calendarId,
        eventId: booking.google_event_id, booking, serviceName,
      });
      return;
    }
    const eventId = await insertEvent({
      accessToken: conn.accessToken, calendarId: conn.calendarId,
      booking, serviceName,
    });
    await sql`
      UPDATE bookings SET google_event_id = ${eventId}
      WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
    `;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[google-sync] create failed for booking', bookingId, err.message);
  }
}

// Push an edit (date/time/recurrence/notes change). If we somehow lost
// the event id (sync was off when booking was made, then turned on),
// fall back to insert.
export async function syncOnBookingUpdated({ workspaceId, bookingId }) {
  try {
    const conn = await loadConnection(workspaceId);
    if (!conn) return;

    const { rows } = await sql`
      SELECT * FROM bookings WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
    `;
    const booking = rows[0];
    if (!booking) return;

    if (booking.cancelled_at) {
      if (booking.google_event_id) {
        await deleteEvent({
          accessToken: conn.accessToken, calendarId: conn.calendarId,
          eventId: booking.google_event_id,
        });
        await sql`UPDATE bookings SET google_event_id = NULL WHERE id = ${bookingId}`;
      }
      return;
    }

    const serviceName = await lookupServiceName(booking.service_id);
    if (booking.google_event_id) {
      await updateEvent({
        accessToken: conn.accessToken, calendarId: conn.calendarId,
        eventId: booking.google_event_id, booking, serviceName,
      });
    } else {
      const eventId = await insertEvent({
        accessToken: conn.accessToken, calendarId: conn.calendarId,
        booking, serviceName,
      });
      await sql`
        UPDATE bookings SET google_event_id = ${eventId}
        WHERE id = ${bookingId} AND workspace_id = ${workspaceId}
      `;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[google-sync] update failed for booking', bookingId, err.message);
  }
}

// Hard-delete from Google when the booking is cancelled or removed.
export async function syncOnBookingDeleted({ workspaceId, googleEventId }) {
  if (!googleEventId) return;
  try {
    const conn = await loadConnection(workspaceId);
    if (!conn) return;
    await deleteEvent({
      accessToken: conn.accessToken, calendarId: conn.calendarId,
      eventId: googleEventId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[google-sync] delete failed:', err.message);
  }
}
