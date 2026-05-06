// Shared post-booking side-effects: auto-create a chat thread for the
// (workspace, client) pair, post a system message describing the booking,
// and send confirmation emails to client + owner.
//
// Called from:
//   • POST /api/calendar/public/:slug  (public booking link)
//   • POST /api/calendar/bookings      (owner manually adds)
//
// Everything runs server-side, fire-and-forget. The booking creation
// succeeds even if email or thread inserts fail — those errors get
// reported to Sentry but don't surface to the caller.
import { sql } from './db.js';
import { sendEmail, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';
import { notifyOwnerSafe } from './push.js';

function fmtDate(iso) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Fetches everything we need about a booking + workspace in a single
// round-trip, then dispatches thread + emails in parallel.
//
// `source`: 'public' | 'owner' — controls the email copy ("you booked
// with us" vs "a new booking just landed").
export async function notifyNewBooking({ workspaceId, bookingId, source = 'public' }) {
  try {
    const { rows } = await sql`
      SELECT
        b.id, b.client_id, b.client_name, b.client_email,
        b.date, b.start_min, b.end_min, b.notes,
        b.video_room_url, b.location_address,
        s.name AS service_name, s.location_type, s.location_label,
        cs.biz_name,
        cs.slug,
        u.email AS owner_email,
        u.name AS owner_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN workspaces w ON w.id = b.workspace_id
      LEFT JOIN users u ON u.id = w.owner_id
      WHERE b.id = ${bookingId}
    `;
    const ctx = rows[0];
    if (!ctx) return;

    const dateISO = ctx.date instanceof Date ? ctx.date.toISOString().slice(0, 10) : ctx.date;
    const businessName = ctx.biz_name || 'Your business';
    const serviceName  = ctx.service_name || 'Session';
    const dateLabel    = fmtDate(dateISO);
    const timeLabel    = `${fmtTime(ctx.start_min)} – ${fmtTime(ctx.end_min)}`;

    // Branding wraps both client + owner emails. Cheap fetch — single
    // SELECT — done once and shared across all recipients.
    const branding = await fetchBranding(workspaceId);

    const tasks = [];

    // 1. Thread + system message — only if the booking is tied to a client
    //    record. Walk-ins with no client linkage skip this.
    if (ctx.client_id) {
      tasks.push(upsertThreadAndSystemMessage({
        workspaceId,
        clientId: ctx.client_id,
        text: `📅 New booking: ${serviceName} on ${dateLabel} at ${fmtTime(ctx.start_min)}.`,
        meta: { bookingId: ctx.id, source },
      }));
    }

    // 2. Confirmation email to client
    if (ctx.client_email) {
      tasks.push(sendClientConfirm({
        to: ctx.client_email,
        clientName: ctx.client_name,
        businessName,
        serviceName,
        dateLabel,
        timeLabel,
        notes: ctx.notes,
        videoRoomUrl: ctx.location_type === 'virtual' && ctx.location_label
          ? ctx.location_label
          : ctx.video_room_url,
        // Mobile bookings carry the address the client supplied. In-person
        // bookings fall back to the service's saved venue ("My home studio",
        // "123 Main St"). Either way, surfaces in the "Where" row.
        locationAddress: ctx.location_address || (ctx.location_type === 'in_person' ? ctx.location_label : null),
        source,
        branding,
      }));
    }

    // 3. Notification email to owner — only for public bookings (owner
    //    manually adding a booking already knows it happened).
    if (source === 'public' && ctx.owner_email) {
      tasks.push(sendOwnerNotify({
        to: ctx.owner_email,
        ownerName: ctx.owner_name,
        clientName: ctx.client_name,
        clientEmail: ctx.client_email,
        serviceName,
        dateLabel,
        timeLabel,
        notes: ctx.notes,
        branding,
      }));
    }

    // 4. Push notification to owner — same gating as the email (public
    //    bookings only). Useful when the owner has the app open in
    //    another tab or installed as a PWA.
    if (source === 'public') {
      tasks.push(notifyOwnerSafe({
        workspaceId,
        type: 'bookings',
        payload: {
          title: 'New booking',
          body: `${ctx.client_name || 'A client'} · ${serviceName} · ${dateLabel} ${fmtTime(ctx.start_min)}`,
          url: `/calendar`,
          tag: `booking-${ctx.id}`,
        },
      }));
    }

    // Run in parallel; isolate failures so a bad email doesn't kill the
    // thread insert and vice versa.
    await Promise.allSettled(tasks).then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') {
          // eslint-disable-next-line no-console
          console.error('[notifyNewBooking] subtask failed:', r.reason?.message || r.reason);
          reportError(r.reason, { extra: { bookingId, workspaceId, source } });
        }
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifyNewBooking] failed:', err.message);
    reportError(err, { extra: { bookingId, workspaceId, source } });
    // Swallow — the caller already returned 201 to the user.
  }
}

async function upsertThreadAndSystemMessage({ workspaceId, clientId, text, meta }) {
  const tIns = await sql`
    INSERT INTO message_threads (workspace_id, client_id)
    VALUES (${workspaceId}, ${clientId})
    ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
    RETURNING id
  `;
  const threadId = tIns.rows[0].id;
  await sql`
    INSERT INTO messages (thread_id, sender, text, kind, meta)
    VALUES (${threadId}, 'system', ${text}, 'booking', ${JSON.stringify(meta)}::jsonb)
  `;
  // Bump the thread preview so both inboxes show "📅 New booking…" at the top.
  const preview = text.slice(0, 200);
  await sql`
    UPDATE message_threads SET
      last_message_at = NOW(),
      last_message_preview = ${preview},
      unread_biz = unread_biz + 1
    WHERE id = ${threadId}
  `;
}

async function sendClientConfirm({ to, clientName, businessName, serviceName, dateLabel, timeLabel, notes, source, branding, videoRoomUrl, locationAddress }) {
  const greeting = clientName ? `Hi ${escapeHtml(clientName.split(/\s+/)[0])},` : 'Hi,';
  const opener = source === 'public'
    ? `Your booking with <strong>${escapeHtml(businessName)}</strong> is confirmed.`
    : `<strong>${escapeHtml(businessName)}</strong> just booked you in.`;
  const html = emailShell({
    heading: 'Booking confirmed',
    body: `<p>${greeting}</p>
      <p>${opener}</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(dateLabel)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(timeLabel)}</td></tr>
        ${locationAddress ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;vertical-align:top;">Where</td><td style="padding:6px 0;">${escapeHtml(locationAddress)}</td></tr>` : ''}
        ${notes ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;vertical-align:top;">Note</td><td style="padding:6px 0;">${escapeHtml(notes)}</td></tr>` : ''}
      </table>
      ${videoRoomUrl ? `<p style="margin:18px 0;padding:12px 14px;background:#F6F5F1;border:1px solid #E8E4DC;border-radius:10px;">
        <strong>Meeting link:</strong><br/>
        <a href="${escapeHtml(videoRoomUrl)}" style="color:#2E3168;word-break:break-all;">${escapeHtml(videoRoomUrl)}</a>
        <br/><span style="font-size:12px;color:#85827B;">Save this — open it at the start of your session.</span>
      </p>` : ''}
      <p>Need to reschedule or message ${escapeHtml(businessName)}? You can view this booking
      and chat with them through your THRYVE portal.</p>`,
    ctaText: 'Open my portal',
    ctaUrl: `${appUrl()}/me`,
    footer: `If you didn't make this booking, please reach out to ${escapeHtml(businessName)} directly.`,
    branding,
  });
  await sendEmail({ to, subject: `Booking confirmed — ${dateLabel}`, html, replyTo: branding?.replyTo });
}

async function sendOwnerNotify({ to, ownerName, clientName, clientEmail, serviceName, dateLabel, timeLabel, notes, branding }) {
  const greeting = ownerName ? `Hi ${escapeHtml(ownerName.split(/\s+/)[0])},` : 'Hi,';
  const html = emailShell({
    heading: 'New booking',
    branding,
    body: `<p>${greeting}</p>
      <p><strong>${escapeHtml(clientName || 'A client')}</strong> just booked through your THRYVE link.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(dateLabel)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(timeLabel)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Email</td><td style="padding:6px 0;">${escapeHtml(clientEmail || '—')}</td></tr>
        ${notes ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;vertical-align:top;">Note</td><td style="padding:6px 0;">${escapeHtml(notes)}</td></tr>` : ''}
      </table>
      <p>The booking is on your calendar and a chat thread is ready for ${escapeHtml(clientName || 'them')}
      under Messages.</p>`,
    ctaText: 'Open the calendar',
    ctaUrl: `${appUrl()}/calendar`,
    footer: `You're getting this because someone booked through your public THRYVE link. Manage notification preferences from Account.`,
  });
  await sendEmail({ to, subject: `New booking — ${clientName || 'client'} · ${dateLabel}`, html });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
