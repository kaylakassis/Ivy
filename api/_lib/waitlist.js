// Shared helpers for the waitlist_entries table. Two consumers:
//   • Public booking flow - clients join the waitlist when a slot is full
//   • Cancellation paths - promote the oldest waiting entry into a real
//     booking + notify the client they're in
import { sql } from './db.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { sendClientSms } from './sms.js';
import { appUrl } from './tokens.js';
import { hasConflict, depositFor } from './calendar.js';

export function serializeWaitlistEntry(row) {
  if (!row) return null;
  const dateStr = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date;
  return {
    id:            row.id,
    serviceId:     row.service_id,
    clientId:      row.client_id,
    clientName:    row.client_name,
    clientEmail:   row.client_email,
    clientPhone:   row.client_phone,
    date:          dateStr,
    startMin:      row.start_min,
    endMin:        row.end_min,
    notes:         row.notes || null,
    status:        row.status,
    promotedBookingId: row.promoted_booking_id,
    promotedAt:    row.promoted_at,
    createdAt:     row.created_at,
  };
}

// Promote the oldest waiting entry for the cancelled slot into a real
// booking. Called from booking-cancel paths. Best-effort: a missing /
// already-promoted queue is a no-op. Returns the promoted booking row
// on success, null if no one was promoted.
//
// Picks by oldest created_at among waiting entries for this exact
// (workspace, service, date, start_min, end_min). Only one promotion
// per cancellation - if the cancelled booking freed a single seat in a
// group class with ≥2 spots open, only one waiter advances; the next
// cancel promotes the next one.
export async function promoteWaitlistOnCancel({ workspaceId, serviceId, dateISO, startMin, endMin }) {
  if (!serviceId) return null;
  const date = dateISO instanceof Date ? dateISO.toISOString().slice(0, 10) : dateISO;

  // Find next-in-line.
  const next = await sql`
    SELECT * FROM waitlist_entries
    WHERE workspace_id = ${workspaceId}
      AND service_id = ${serviceId}
      AND date = ${date}
      AND start_min = ${startMin}
      AND end_min = ${endMin}
      AND status = 'waiting'
    ORDER BY created_at ASC
    LIMIT 1
  `;
  if (next.rows.length === 0) return null;
  const w = next.rows[0];

  // Atomically claim the entry - switch its status before inserting the
  // booking so a concurrent cancel can't double-promote the same entry.
  const claim = await sql`
    UPDATE waitlist_entries SET status = 'promoted', promoted_at = NOW()
    WHERE id = ${w.id} AND status = 'waiting'
    RETURNING id
  `;
  if (claim.rows.length === 0) return null; // someone else got it

  // Capacity recheck: the freed seat may have been re-booked by a public
  // booker between the cancel and this promotion. Pull the service +
  // workspace buffers and run the same overlap check the booker uses; if
  // the slot is full again, put the waiter back in line and bail rather
  // than over-book.
  const svcRows = await sql`
    SELECT id, capacity, price, deposit_type, deposit_amount, travel_buffer_minutes
    FROM services WHERE id = ${serviceId} AND workspace_id = ${workspaceId}
  `;
  const svc = svcRows.rows[0];
  const csRows = await sql`
    SELECT buffer_minutes FROM calendar_settings WHERE workspace_id = ${workspaceId}
  `;
  const bufferMin = Math.max(0, Number(csRows.rows[0]?.buffer_minutes || 0));
  const serviceCapacity = Math.max(1, Number(svc?.capacity) || 1);
  const travelBufferMin = Math.max(0, Number(svc?.travel_buffer_minutes || 0));

  const slotFull = await hasConflict({
    workspaceId, dateISO: date, start: w.start_min, end: w.end_min,
    serviceId, capacity: serviceCapacity, travelBufferMin, bufferMin,
  });
  if (slotFull) {
    // Release the claim - the waiter keeps their place for the next opening.
    await sql`
      UPDATE waitlist_entries SET status = 'waiting', promoted_at = NULL
      WHERE id = ${w.id} AND status = 'promoted' AND promoted_booking_id IS NULL
    `;
    return null;
  }

  // Snapshot deposit + total from the service so the promoted booking has
  // the same financial fields a normal booking would (waitlist entries
  // carry no add-ons, so the base service price is the total).
  const bookingTotal = Number(svc?.price || 0);
  const depositRequired = depositFor(svc, bookingTotal);

  // Reuse the same client-row attach logic the public booker uses.
  let clientId = w.client_id;
  if (!clientId && w.client_email) {
    const existing = await sql`
      SELECT id FROM clients WHERE workspace_id = ${workspaceId} AND email = ${w.client_email} LIMIT 1
    `;
    if (existing.rows.length > 0) {
      clientId = existing.rows[0].id;
      await sql`UPDATE clients SET last_seen_at = NOW() WHERE id = ${clientId}`;
    } else {
      const created = await sql`
        INSERT INTO clients (workspace_id, name, email, phone, stage, source, last_seen_at)
        VALUES (${workspaceId}, ${w.client_name}, ${w.client_email}, ${w.client_phone},
                'lead', 'Waitlist', NOW())
        RETURNING id
      `;
      clientId = created.rows[0].id;
    }
  }

  const booking = await sql`
    INSERT INTO bookings (
      workspace_id, service_id, client_id, client_name, client_email, client_phone,
      date, start_min, end_min, notes, deposit_required, booking_total
    ) VALUES (
      ${workspaceId}, ${serviceId}, ${clientId}, ${w.client_name}, ${w.client_email}, ${w.client_phone},
      ${date}, ${w.start_min}, ${w.end_min}, ${w.notes}, ${depositRequired}, ${bookingTotal}
    )
    RETURNING *
  `;

  await sql`
    UPDATE waitlist_entries SET promoted_booking_id = ${booking.rows[0].id}
    WHERE id = ${w.id}
  `;

  // Email + SMS the client. Best-effort; failure logs but doesn't undo
  // the promotion (they still got the seat).
  notifyPromotion({ workspaceId, entry: w, booking: booking.rows[0] }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[waitlist] notify failed:', err.message);
  });

  return booking.rows[0];
}

async function notifyPromotion({ workspaceId, entry, booking }) {
  const { rows } = await sql`
    SELECT cs.biz_name, s.name AS service_name
    FROM calendar_settings cs
    LEFT JOIN services s ON s.id = ${entry.service_id}
    WHERE cs.workspace_id = ${workspaceId}
  `;
  const bizName = rows[0]?.biz_name || 'Your business';
  const serviceName = rows[0]?.service_name || 'Session';
  const dateLabel = new Date(entry.date + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  const timeLabel = fmtTime(entry.start_min);

  if (entry.client_email) {
    const branding = await fetchBranding(workspaceId);
    const html = emailShell({
      heading: 'Good news - a spot just opened up!',
      body: `<p>Hi ${escapeHtml(firstName(entry.client_name))},</p>
        <p>You're off the waitlist - your <strong>${escapeHtml(serviceName)}</strong>
        with <strong>${escapeHtml(bizName)}</strong> is confirmed for
        <strong>${escapeHtml(dateLabel)}</strong> at <strong>${escapeHtml(timeLabel)}</strong>.</p>
        <p>If this no longer works, you can cancel from your portal.</p>`,
      ctaText: 'See in my portal',
      ctaUrl: `${appUrl()}/me/bookings`,
      branding,
    });
    await sendEmailToClient({
      clientId: entry.client_id, type: 'bookings',
      to: entry.client_email,
      subject: `You're in - ${serviceName} on ${dateLabel}`,
      html,
      replyTo: branding.replyTo,
    });
  }

  if (entry.client_phone) {
    // Lookup consent - same one-number-one-consent pattern as reminders.
    const c = await sql`SELECT sms_consent_at FROM clients WHERE phone = ${entry.client_phone} LIMIT 1`;
    await sendClientSms({
      phone:       entry.client_phone,
      consentAt:   c.rows[0]?.sms_consent_at || null,
      body:        `${bizName}: a spot opened up - your ${serviceName} on ${dateLabel} at ${timeLabel} is confirmed.`,
      workspaceId: entry.workspace_id,
    });
  }
}

function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
function firstName(s) { return (s || 'there').trim().split(/\s+/)[0] || 'there'; }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
