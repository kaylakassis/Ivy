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
  refreshAccessToken, insertEvent, updateEvent, deleteEvent, listEvents,
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

// Express an absolute instant as wall-clock { date, minutes } in the
// workspace's IANA timezone. Ivy OS bookings/slots use floating LOCAL
// time, so a Google event at 2pm Pacific must block the 2pm slot — not
// 9pm (its UTC hour). When no workspace timezone is configured we fall
// back to the event's own wall-clock (the time as written before the
// RFC3339 offset), which is still closer than coercing to UTC.
function eventLocalParts(rfc3339, timeZone) {
  if (timeZone) {
    try {
      const d = new Date(rfc3339);
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(d).map((p) => [p.type, p.value]),
      );
      let hour = parseInt(parts.hour, 10);
      if (hour === 24) hour = 0; // some runtimes emit 24 for midnight
      return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        minutes: hour * 60 + parseInt(parts.minute, 10),
      };
    } catch { /* bad tz string — fall through to wall-clock parse */ }
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(rfc3339));
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, minutes: (+m[4]) * 60 + (+m[5]) };
  const d = new Date(rfc3339);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// Pull busy times from the owner's primary Google calendar over the
// next `daysAhead` days and mirror them into external_busy_blocks. The
// dedicated Ivy OS Bookings calendar (where we PUSH) is excluded so
// pushed bookings don't double-count.
//
// Diff strategy: list events, upsert each by source_event_id, then
// delete any rows for this workspace whose source_event_id wasn't in
// the latest pull. So cancellations in upstream Google free the slot
// back up automatically.
//
// All-day events (DTSTART is a 'date' not 'dateTime') are skipped —
// "out for the day" should block via blocks/availability anyway, and
// taking a whole day off via a Google all-day event would be surprising.
export async function pullBusyTimes({ workspaceId, daysAhead = 60 }) {
  const { rows } = await sql`
    SELECT google_refresh_token_encrypted, google_calendar_id, google_block_inbound,
           google_email, timezone
    FROM calendar_settings
    WHERE workspace_id = ${workspaceId}
  `;
  const r = rows[0];
  if (!r) return { ok: false, reason: 'workspace not found' };
  if (!r.google_refresh_token_encrypted) return { ok: false, reason: 'not connected' };
  if (!r.google_block_inbound) return { ok: false, reason: 'inbound disabled' };

  let refreshToken;
  try { refreshToken = decrypt(r.google_refresh_token_encrypted); }
  catch { return { ok: false, reason: 'token decrypt failed' }; }

  let accessToken;
  try { accessToken = await refreshAccessToken(refreshToken); }
  catch (err) { return { ok: false, reason: `refresh failed: ${err.message}` }; }

  const now = new Date();
  const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const timeMin = now.toISOString();
  const timeMax = end.toISOString();

  let events;
  try {
    events = await listEvents({ accessToken, calendarId: 'primary', timeMin, timeMax });
  } catch (err) {
    return { ok: false, reason: `list failed: ${err.message}` };
  }

  const ivyCalId = r.google_calendar_id;
  const seenIds = [];
  let kept = 0, skipped = 0;

  for (const ev of events) {
    if (ev.status === 'cancelled') continue;
    // Don't block on events the user already marked as available.
    if (ev.transparency === 'transparent') { skipped++; continue; }
    // Skip events from our own dedicated Ivy OS calendar — those are
    // bookings we pushed; double-counting them would block our own
    // future slots from existing bookings.
    if (ev.organizer?.email === r.google_email && ev.calendarId === ivyCalId) continue;
    // FreeBusy-style: only need start + end.
    const start = ev.start?.dateTime;
    const end = ev.end?.dateTime;
    if (!start || !end) { skipped++; continue; }   // all-day, skip

    // Convert to the workspace's local wall-clock so busy blocks line up
    // with Ivy OS's local-time slot model (see eventLocalParts above).
    const sp = eventLocalParts(start, r.timezone);
    const ep = eventLocalParts(end, r.timezone);
    const dateA = sp.date;
    const dateB = ep.date;
    // Only mirror events that fall on a single local date — multi-day
    // events need expanding into per-day rows. Rare for personal events; punt.
    if (dateA !== dateB) { skipped++; continue; }

    const startMin = sp.minutes;
    const endMin   = ep.minutes;
    if (endMin <= startMin) continue;

    seenIds.push(ev.id);
    await sql`
      INSERT INTO external_busy_blocks (
        workspace_id, source, source_event_id, date, start_min, end_min, summary, last_synced_at
      ) VALUES (
        ${workspaceId}, 'google', ${ev.id}, ${dateA}, ${startMin}, ${endMin},
        ${ev.summary?.slice(0, 200) || null}, NOW()
      )
      ON CONFLICT (workspace_id, source, source_event_id) DO UPDATE SET
        date = EXCLUDED.date,
        start_min = EXCLUDED.start_min,
        end_min = EXCLUDED.end_min,
        summary = EXCLUDED.summary,
        last_synced_at = EXCLUDED.last_synced_at
    `;
    kept++;
  }

  // Delete blocks no longer present upstream. Anchored on source +
  // workspace so we never touch another tenant's data.
  if (seenIds.length > 0) {
    await sql.query(
      `DELETE FROM external_busy_blocks
       WHERE workspace_id = $1 AND source = 'google' AND NOT (source_event_id = ANY($2))`,
      [workspaceId, seenIds],
    );
  } else {
    // No upstream events at all → wipe.
    await sql`DELETE FROM external_busy_blocks WHERE workspace_id = ${workspaceId} AND source = 'google'`;
  }

  await sql`
    UPDATE calendar_settings SET
      google_inbound_last_sync_at = NOW(),
      google_inbound_last_error   = NULL
    WHERE workspace_id = ${workspaceId}
  `;
  return { ok: true, kept, skipped, total: events.length };
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
