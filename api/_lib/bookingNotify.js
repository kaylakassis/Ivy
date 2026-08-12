// Shared post-booking side-effects: auto-create a chat thread for the
// (workspace, client) pair, post a system message describing the booking,
// and send confirmation emails to client + owner.
//
// Called from:
//   • POST /api/calendar/public/:slug  (public booking link)
//   • POST /api/calendar/bookings      (owner manually adds)
//
// Everything runs server-side, fire-and-forget. The booking creation
// succeeds even if email or thread inserts fail - those errors get
// reported to Sentry but don't surface to the caller.
import { sql } from './db.js';
import { sendEmail, sendEmailToClient, sendEmailToUser, emailShell } from './email.js';
import { buildBookingInvite } from './ical.js';
import { sendClientSms } from './sms.js';
import { celebrateFirstBooking, celebrateBookingMilestones } from './milestones.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';
import { notifyOwnerSafe, notifyClientSafe } from './push.js';

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
// `source`: 'public' | 'owner' - controls the email copy ("you booked
// with us" vs "a new booking just landed").
export async function notifyNewBooking({ workspaceId, bookingId, source = 'public' }) {
  try {
    const { rows } = await sql`
      SELECT
        b.id, b.client_id, b.client_name, b.client_email,
        b.date, b.start_min, b.end_min, b.notes,
        b.video_room_url, b.location_address,
        b.client_phone,
        c.sms_consent_at,
        s.name AS service_name, s.location_type, s.location_label,
        cs.biz_name,
        cs.slug,
        cs.timezone,
        w.owner_id,
        u.email AS owner_email,
        u.name AS owner_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN clients c ON c.id = b.client_id
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

    // Branding wraps both client + owner emails. Cheap fetch - single
    // SELECT - done once and shared across all recipients.
    const branding = await fetchBranding(workspaceId);

    const tasks = [];

    // 0. Booking milestones - a one-time celebration in the owner's feed for
    //    the first booking, then again at each mid-journey tier (10, 25, ...).
    tasks.push(celebrateFirstBooking(workspaceId));
    tasks.push(celebrateBookingMilestones(workspaceId));

    // 1. Thread + system message - only if the booking is tied to a client
    //    record. Walk-ins with no client linkage skip this.
    if (ctx.client_id) {
      tasks.push(upsertThreadAndSystemMessage({
        workspaceId,
        clientId: ctx.client_id,
        text: `📅 New booking: ${serviceName} on ${dateLabel} at ${fmtTime(ctx.start_min)}.`,
        meta: { bookingId: ctx.id, source },
      }));
    }

    // 2. Confirmation email to client. Prefs-gated by clients.id when we
    //    have one (rare to send when no client row exists; walk-ins go
    //    by the literal email and no clients row exists to check).
    //    Waitlist promotions skip this - waitlist.js sends its own
    //    "You're off the waitlist" email; sending both meant two
    //    overlapping confirmations for the same seat.
    if (ctx.client_email && source !== 'waitlist') {
      tasks.push(sendClientConfirm({
        clientId: ctx.client_id,
        to: ctx.client_email,
        clientName: ctx.client_name,
        businessName,
        serviceName,
        dateLabel,
        timeLabel,
        // Raw fields for the add-to-calendar .ics attachment.
        bookingId: ctx.id,
        dateISO,
        startMin: ctx.start_min,
        endMin: ctx.end_min,
        timezone: ctx.timezone || null,
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

    // 2b. Confirmation SMS to the client - only when they gave a phone AND
    //     opted in (sms_consent_at). Transactional, so it ignores quiet hours.
    //     No-ops safely when Twilio isn't configured. Best-effort.
    if (ctx.client_phone && ctx.sms_consent_at) {
      const smsBody = `${businessName}: your booking for ${serviceName} on ${dateLabel} at ${fmtTime(ctx.start_min)} is confirmed.`;
      tasks.push(sendClientSms({
        phone: ctx.client_phone,
        consentAt: ctx.sms_consent_at,
        body: smsBody,
        workspaceId,
        respectQuietHours: false,
      }).catch((e) => console.error('[booking] confirm SMS failed:', e?.message)));
    }

    // 3. Notification email to owner - only for public bookings (owner
    //    manually adding a booking already knows it happened).
    if (source === 'public' && ctx.owner_email) {
      tasks.push(sendOwnerNotify({
        ownerId: ctx.owner_id,
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

    // 4. Push notification to owner - same gating as the email (public
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
    // Swallow - the caller already returned 201 to the user.
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

async function sendClientConfirm({ clientId, to, clientName, businessName, serviceName, dateLabel, timeLabel, notes, source, branding, videoRoomUrl, locationAddress, bookingId, dateISO, startMin, endMin, timezone }) {
  // Portal CTA: claimed clients (clients.user_id IS NOT NULL) land
  // straight at /me. Unclaimed walk-ins or never-signed-up public
  // bookers go to /signup with the email pre-filled - hitting /me
  // logged-out bounces to /signin with confusing "no account" friction.
  let hasPortal = false;
  if (clientId) {
    try {
      const r = await sql`SELECT user_id FROM clients WHERE id = ${clientId} LIMIT 1`;
      hasPortal = !!r.rows[0]?.user_id;
    } catch { /* default to signup path */ }
  }
  const portalUrl = hasPortal
    ? `${appUrl()}/me`
    : `${appUrl()}/signup?mode=client&email=${encodeURIComponent(to)}`;
  const portalCtaText = hasPortal ? 'Open my portal' : 'Claim your portal account';

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
        <br/><span style="font-size:12px;color:#85827B;">Save this - open it at the start of your session.</span>
      </p>` : ''}
      <p>Need to reschedule or message ${escapeHtml(businessName)}? ${hasPortal
        ? 'You can view this booking and chat with them through your Ivy portal.'
        : 'Create a free Ivy portal account to see this booking, future visits, invoices, and messages from them in one place.'}</p>`,
    ctaText: portalCtaText,
    ctaUrl: portalUrl,
    footer: `If you didn't make this booking, please reach out to ${escapeHtml(businessName)} directly.`,
    branding,
  });
  // Add-to-calendar attachment - lets the client one-tap save the booking to
  // their own calendar (a well-established no-show reducer). Best-effort: if
  // we're missing the raw date/time we just skip it rather than fail the send.
  let attachments;
  if (dateISO && startMin != null && endMin != null) {
    try {
      const ics = buildBookingInvite({
        bizName: businessName,
        serviceName,
        date: dateISO,
        startMin,
        endMin,
        bookingId,
        timezone,
        locationAddress: videoRoomUrl || locationAddress || null,
        description: videoRoomUrl
          ? `Booked with ${businessName} via Ivy. Join: ${videoRoomUrl}`
          : `Booked with ${businessName} via Ivy.`,
      });
      attachments = [{
        filename: 'booking.ics',
        content: Buffer.from(ics, 'utf8').toString('base64'),
        contentType: 'text/calendar; method=PUBLISH; charset=UTF-8',
      }];
    } catch { /* skip the attachment, still send the email */ }
  }

  await sendEmailToClient({
    clientId, type: 'bookings',
    to, subject: `Booking confirmed - ${dateLabel}`, html, replyTo: branding?.replyTo,
    attachments,
  });
}

async function sendOwnerNotify({ ownerId, to, ownerName, clientName, clientEmail, serviceName, dateLabel, timeLabel, notes, branding }) {
  const greeting = ownerName ? `Hi ${escapeHtml(ownerName.split(/\s+/)[0])},` : 'Hi,';
  const html = emailShell({
    heading: 'New booking',
    branding,
    body: `<p>${greeting}</p>
      <p><strong>${escapeHtml(clientName || 'A client')}</strong> just booked through your Ivy link.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(dateLabel)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(timeLabel)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Email</td><td style="padding:6px 0;">${escapeHtml(clientEmail || '-')}</td></tr>
        ${notes ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;vertical-align:top;">Note</td><td style="padding:6px 0;">${escapeHtml(notes)}</td></tr>` : ''}
      </table>
      <p>The booking is on your calendar and a chat thread is ready for ${escapeHtml(clientName || 'them')}
      under Messages.</p>`,
    ctaText: 'Open the calendar',
    ctaUrl: `${appUrl()}/calendar`,
    footer: `You're getting this because someone booked through your public Ivy link. Manage notification preferences from Account.`,
  });
  await sendEmailToUser({
    userId: ownerId, type: 'bookings',
    to, subject: `New booking - ${clientName || 'client'} · ${dateLabel}`, html,
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─────────────────────────────────────────────────────────────────────
// Cancellation notifications
// ─────────────────────────────────────────────────────────────────────
//
// Fires when a booking (or single occurrence in a recurring series) is
// cancelled. `source` controls the copy:
//   • 'owner'  → owner-initiated cancel → email to client ("your appt was cancelled")
//   • 'client' → client-initiated cancel via portal → email to owner
//                ("X cancelled their appointment")
// Both directions also get a thread system message + push.
export async function notifyBookingCancellation({ workspaceId, bookingId, occurrenceDate = null, source = 'owner' }) {
  try {
    const { rows } = await sql`
      SELECT
        b.id, b.client_id, b.client_name, b.client_email,
        b.date, b.start_min, b.end_min,
        s.name AS service_name,
        cs.biz_name,
        w.owner_id,
        u.email AS owner_email, u.name AS owner_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN workspaces w ON w.id = b.workspace_id
      LEFT JOIN users u ON u.id = w.owner_id
      WHERE b.id = ${bookingId}
    `;
    const ctx = rows[0];
    if (!ctx) return;

    const dateISO = occurrenceDate
      || (ctx.date instanceof Date ? ctx.date.toISOString().slice(0, 10) : ctx.date);
    const businessName = ctx.biz_name || 'Your business';
    const serviceName = ctx.service_name || 'Session';
    const dateLabel = fmtDate(dateISO);
    const timeLabel = `${fmtTime(ctx.start_min)} – ${fmtTime(ctx.end_min)}`;
    const branding = await fetchBranding(workspaceId);

    const tasks = [];

    if (ctx.client_id) {
      const text = source === 'owner'
        ? `❌ Cancelled: ${serviceName} on ${dateLabel} at ${fmtTime(ctx.start_min)}.`
        : `❌ Client cancelled: ${serviceName} on ${dateLabel} at ${fmtTime(ctx.start_min)}.`;
      tasks.push(upsertThreadAndSystemMessage({
        workspaceId, clientId: ctx.client_id,
        text,
        meta: { bookingId: ctx.id, source, occurrenceDate: dateISO, kind: 'cancellation' },
      }));
    }

    // Client-facing email + push (when the owner cancelled)
    if (source === 'owner' && ctx.client_email) {
      tasks.push(sendCancellationToClient({
        clientId: ctx.client_id,
        to: ctx.client_email,
        clientName: ctx.client_name,
        businessName, serviceName, dateLabel, timeLabel, branding,
      }));
    }
    // Client-side push when owner cancels - email may sit unread for
    // hours; the client needs to know their appointment is off NOW.
    if (source === 'owner' && ctx.client_id) {
      tasks.push(notifyClientSafe({
        clientId: ctx.client_id,
        type: 'bookings',
        payload: {
          title: 'Appointment cancelled',
          body: `${businessName} cancelled ${serviceName} on ${dateLabel} at ${fmtTime(ctx.start_min)}`,
          url: '/me/bookings',
          tag: `booking-cancel-${ctx.id}-${dateISO}`,
        },
      }));
    }

    // Owner-facing email (when the client cancelled via portal)
    if (source === 'client' && ctx.owner_email) {
      tasks.push(sendCancellationToOwner({
        ownerId: ctx.owner_id,
        to: ctx.owner_email,
        ownerName: ctx.owner_name,
        clientName: ctx.client_name,
        clientEmail: ctx.client_email,
        businessName, serviceName, dateLabel, timeLabel, branding,
      }));
    }

    // Owner-side push regardless of direction (owner always wants to know).
    if (ctx.owner_id || source === 'client') {
      tasks.push(notifyOwnerSafe({
        workspaceId,
        type: 'bookings',
        payload: {
          title: source === 'client' ? 'Booking cancelled by client' : 'Booking cancelled',
          body: `${ctx.client_name || 'Client'} · ${serviceName} · ${dateLabel} ${fmtTime(ctx.start_min)}`,
          url: '/calendar',
          tag: `booking-cancel-${ctx.id}-${dateISO}`,
        },
      }));
    }

    await Promise.allSettled(tasks).then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') {
          console.error('[notifyBookingCancellation] subtask failed:', r.reason?.message || r.reason);
          reportError(r.reason, { extra: { bookingId, workspaceId, source } });
        }
      }
    });
  } catch (err) {
    console.error('[notifyBookingCancellation] failed:', err.message);
    reportError(err, { extra: { bookingId, workspaceId, source } });
  }
}

async function sendCancellationToClient({ clientId, to, clientName, businessName, serviceName, dateLabel, timeLabel, branding }) {
  const greeting = clientName ? `Hi ${escapeHtml(clientName.split(/\s+/)[0])},` : 'Hi,';
  const html = emailShell({
    heading: 'Your appointment was cancelled',
    branding,
    body: `<p>${greeting}</p>
      <p>Your appointment with <strong>${escapeHtml(businessName)}</strong> was cancelled.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(dateLabel)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(timeLabel)}</td></tr>
      </table>
      <p>If you'd like to rebook, you can pick a new time from your portal.</p>`,
    ctaText: 'Rebook with ' + businessName,
    ctaUrl: `${appUrl()}/me/bookings`,
    footer: `Reach out to ${escapeHtml(businessName)} if this was unexpected.`,
  });
  await sendEmailToClient({
    clientId, type: 'bookings',
    to, subject: `Cancelled: ${serviceName} on ${dateLabel}`, html, replyTo: branding?.replyTo,
  });
}

async function sendCancellationToOwner({ ownerId, to, ownerName, clientName, clientEmail, businessName, serviceName, dateLabel, timeLabel, branding }) {
  const greeting = ownerName ? `Hi ${escapeHtml(ownerName.split(/\s+/)[0])},` : 'Hi,';
  const html = emailShell({
    heading: 'A client cancelled',
    branding,
    body: `<p>${greeting}</p>
      <p><strong>${escapeHtml(clientName || 'A client')}</strong> cancelled their appointment.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(dateLabel)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(timeLabel)}</td></tr>
        ${clientEmail ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;">Email</td><td style="padding:6px 0;">${escapeHtml(clientEmail)}</td></tr>` : ''}
      </table>
      <p>The slot is now free again. If you have a waitlist for this service, the next person up may be auto-promoted.</p>`,
    ctaText: 'Open the calendar',
    ctaUrl: `${appUrl()}/calendar`,
    footer: `You're getting this because your client cancelled through their portal. Manage notification preferences from Account.`,
  });
  await sendEmailToUser({
    userId: ownerId, type: 'bookings',
    to, subject: `Cancelled by ${clientName || 'client'} - ${dateLabel}`, html,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Reschedule notifications
// ─────────────────────────────────────────────────────────────────────
//
// Fires when a booking is moved to a new time. Both directions:
//   • 'owner'  → owner moved a booking → email client with the new slot
//   • 'client' → client rescheduled via portal → email owner with the change
export async function notifyBookingRescheduled({ workspaceId, bookingId, oldDateISO, oldStartMin, oldEndMin, source = 'owner' }) {
  try {
    const { rows } = await sql`
      SELECT
        b.id, b.client_id, b.client_name, b.client_email,
        b.date, b.start_min, b.end_min,
        s.name AS service_name,
        cs.biz_name,
        w.owner_id,
        u.email AS owner_email, u.name AS owner_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN workspaces w ON w.id = b.workspace_id
      LEFT JOIN users u ON u.id = w.owner_id
      WHERE b.id = ${bookingId}
    `;
    const ctx = rows[0];
    if (!ctx) return;

    const businessName = ctx.biz_name || 'Your business';
    const serviceName  = ctx.service_name || 'Session';
    const newDateISO   = ctx.date instanceof Date ? ctx.date.toISOString().slice(0, 10) : ctx.date;
    const newDate      = fmtDate(newDateISO);
    const newTime      = `${fmtTime(ctx.start_min)} – ${fmtTime(ctx.end_min)}`;
    const oldDate      = oldDateISO ? fmtDate(oldDateISO) : null;
    const oldTime      = (oldStartMin != null && oldEndMin != null) ? `${fmtTime(oldStartMin)} – ${fmtTime(oldEndMin)}` : null;
    const branding = await fetchBranding(workspaceId);

    const tasks = [];

    if (ctx.client_id) {
      tasks.push(upsertThreadAndSystemMessage({
        workspaceId, clientId: ctx.client_id,
        text: `🔁 Rescheduled: ${serviceName} → ${newDate} at ${fmtTime(ctx.start_min)}.`,
        meta: { bookingId: ctx.id, source, kind: 'reschedule' },
      }));
    }

    if (source === 'owner' && ctx.client_email) {
      tasks.push(sendRescheduleToClient({
        clientId: ctx.client_id,
        to: ctx.client_email, clientName: ctx.client_name,
        businessName, serviceName,
        newDate, newTime, oldDate, oldTime, branding,
      }));
    }

    if (source === 'client' && ctx.owner_email) {
      tasks.push(sendRescheduleToOwner({
        ownerId: ctx.owner_id,
        to: ctx.owner_email, ownerName: ctx.owner_name,
        clientName: ctx.client_name, clientEmail: ctx.client_email,
        serviceName, newDate, newTime, oldDate, oldTime, branding,
      }));
    }

    tasks.push(notifyOwnerSafe({
      workspaceId,
      type: 'bookings',
      payload: {
        title: source === 'client' ? 'Booking rescheduled by client' : 'Booking rescheduled',
        body: `${ctx.client_name || 'Client'} · ${serviceName} · ${newDate} ${fmtTime(ctx.start_min)}`,
        url: '/calendar',
        tag: `booking-reschedule-${ctx.id}`,
      },
    }));

    await Promise.allSettled(tasks).then((results) => {
      for (const r of results) {
        if (r.status === 'rejected') {
          console.error('[notifyBookingRescheduled] subtask failed:', r.reason?.message || r.reason);
          reportError(r.reason, { extra: { bookingId, workspaceId, source } });
        }
      }
    });
  } catch (err) {
    console.error('[notifyBookingRescheduled] failed:', err.message);
    reportError(err, { extra: { bookingId, workspaceId, source } });
  }
}

async function sendRescheduleToClient({ clientId, to, clientName, businessName, serviceName, newDate, newTime, oldDate, oldTime, branding }) {
  const greeting = clientName ? `Hi ${escapeHtml(clientName.split(/\s+/)[0])},` : 'Hi,';
  const html = emailShell({
    heading: 'Your appointment was rescheduled',
    branding,
    body: `<p>${greeting}</p>
      <p>Your appointment with <strong>${escapeHtml(businessName)}</strong> has a new time:</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">New date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(newDate)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">New time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(newTime)}</td></tr>
        ${oldDate && oldTime ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;">Was</td><td style="padding:6px 0;color:#85827B;text-decoration:line-through;">${escapeHtml(oldDate)} · ${escapeHtml(oldTime)}</td></tr>` : ''}
      </table>`,
    ctaText: 'Open my portal',
    ctaUrl: `${appUrl()}/me/bookings`,
    footer: `Reach out to ${escapeHtml(businessName)} if this new time doesn't work.`,
  });
  await sendEmailToClient({
    clientId, type: 'bookings',
    to, subject: `Rescheduled: ${serviceName} → ${newDate}`, html, replyTo: branding?.replyTo,
  });
}

async function sendRescheduleToOwner({ ownerId, to, ownerName, clientName, clientEmail, serviceName, newDate, newTime, oldDate, oldTime, branding }) {
  const greeting = ownerName ? `Hi ${escapeHtml(ownerName.split(/\s+/)[0])},` : 'Hi,';
  const html = emailShell({
    heading: 'A client rescheduled',
    branding,
    body: `<p>${greeting}</p>
      <p><strong>${escapeHtml(clientName || 'A client')}</strong> rescheduled their appointment.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">New date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(newDate)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">New time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(newTime)}</td></tr>
        ${oldDate && oldTime ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;">Was</td><td style="padding:6px 0;color:#85827B;text-decoration:line-through;">${escapeHtml(oldDate)} · ${escapeHtml(oldTime)}</td></tr>` : ''}
        ${clientEmail ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;">Email</td><td style="padding:6px 0;">${escapeHtml(clientEmail)}</td></tr>` : ''}
      </table>`,
    ctaText: 'Open the calendar',
    ctaUrl: `${appUrl()}/calendar`,
    footer: `Your client rescheduled through their portal. Manage notification preferences from Account.`,
  });
  await sendEmailToUser({
    userId: ownerId, type: 'bookings',
    to, subject: `Rescheduled by ${clientName || 'client'} - ${newDate}`, html,
  });
}
