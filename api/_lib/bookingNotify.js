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
import { buildInviteIcs, calendarLinksFor, renderAddToCalendar } from './calendarLinks.js';
import { sendClientSms } from './sms.js';
import { celebrateFirstBooking, celebrateBookingMilestones } from './milestones.js';
import { recordFirstRealBooking } from './firstWin.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';
import { notifyOwnerSafe, notifyClientSafe, notifyHelperSafe } from './push.js';
import { keepAlive } from './keepAlive.js';

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
// `source`: 'public' | 'client-portal' | 'owner' | 'waitlist' - who made
// the booking. Client-made bookings ('public' booking page, 'client-portal'
// package booking) tell the owner; owner-made ones tell the client.
//
// Push audience rules (shared by the cancel + reschedule notifiers below):
// whoever did the thing is never pushed about it; the other side is.
//
// Wrapped in keepAlive so callers that fire and forget (most of them) do
// not lose the emails + pushes when the response ends first.
export function notifyNewBooking(args) {
  return keepAlive(notifyNewBookingImpl(args));
}

// `extraNote` (1.0.6): a short message the owner typed when approving a
// booking request, shown in the client's confirmation. `depositPayUrl`: a
// pay link when the deposit could not be taken from the saved card.
async function notifyNewBookingImpl({ workspaceId, bookingId, source = 'public', extraNote = null, depositPayUrl = null }) {
  const clientMade = source === 'public' || source === 'client-portal';
  try {
    const { rows } = await sql`
      SELECT
        b.id, b.client_id, b.client_name, b.client_email,
        b.date, b.start_min, b.end_min, b.notes,
        b.video_room_url, b.location_address,
        b.client_phone, b.staff_id, b.created_at, b.updated_at,
        c.sms_consent_at,
        s.name AS service_name, s.location_type, s.location_label,
        s.prep_instructions,
        cs.biz_name,
        cs.slug,
        cs.timezone,
        w.owner_id,
        u.email AS owner_email,
        u.name AS owner_name,
        b.client_package_id,
        pk.name AS package_name, pk.credits_remaining AS package_remaining,
        pk.status AS package_status,
        (pt.id IS NOT NULL AND pt.active AND pt.visibility = 'public' AND pt.price > 0) AS package_buyable,
        pk.package_id AS package_template_id,
        sh.name AS shop_name, sh.slug AS shop_slug,
        (b.client_package_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM bookings nb
           WHERE nb.client_package_id = b.client_package_id
             AND nb.cancelled_at IS NULL
             AND nb.id <> b.id
             AND (nb.created_at > b.created_at OR (nb.created_at = b.created_at AND nb.id > b.id))
        )) AS package_latest
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN clients c ON c.id = b.client_id
      LEFT JOIN workspaces w ON w.id = b.workspace_id
      LEFT JOIN users u ON u.id = w.owner_id
      LEFT JOIN client_packages pk ON pk.id = b.client_package_id AND pk.workspace_id = b.workspace_id
      LEFT JOIN packages pt ON pt.id = pk.package_id AND pt.workspace_id = b.workspace_id
      LEFT JOIN shops sh ON sh.id = b.shop_id
      WHERE b.id = ${bookingId}
    `;
    const ctx = rows[0];
    if (!ctx) return;

    const dateISO = ctx.date instanceof Date ? ctx.date.toISOString().slice(0, 10) : ctx.date;
    const businessName = ctx.biz_name || 'Your business';
    // Booked from a shop page (1.0.6): one extra line for the owner.
    const shopLine = ctx.shop_name ? `Booked through ${ctx.shop_name}'s page` : null;
    const serviceName  = ctx.service_name || 'Session';
    const dateLabel    = fmtDate(dateISO);
    const timeLabel    = `${fmtTime(ctx.start_min)} to ${fmtTime(ctx.end_min)}`;

    // Branding wraps both client + owner emails. Cheap fetch - single
    // SELECT - done once and shared across all recipients.
    const branding = await fetchBranding(workspaceId);

    const tasks = [];

    // 0. Booking milestones - a one-time celebration in the owner's feed for
    //    the first booking, then again at each mid-journey tier (10, 25, ...).
    //    The first-win path (api/_lib/firstWin.js) owns the first booking a
    //    CLIENT made: it flags the dashboard moment and sends its own
    //    notification, so the generic first-booking milestone is skipped
    //    when it fired. Owner-added and sample bookings never count there.
    const firstWin = await recordFirstRealBooking({ workspaceId, bookingId, source });
    if (!firstWin) tasks.push(celebrateFirstBooking(workspaceId));
    tasks.push(celebrateBookingMilestones(workspaceId));

    // 1. Thread + system message - only if the booking is tied to a client
    //    record. Walk-ins with no client linkage skip this.
    if (ctx.client_id) {
      tasks.push(upsertThreadAndSystemMessage({
        workspaceId,
        clientId: ctx.client_id,
        text: `📅 New booking: ${serviceName} on ${dateLabel} at ${fmtTime(ctx.start_min)}.${shopLine ? ` ${shopLine}.` : ''}`,
        meta: { bookingId: ctx.id, source, ...(ctx.shop_slug ? { shopSlug: ctx.shop_slug } : {}) },
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
        clientId: ctx.client_id, workspaceId,
        to: ctx.client_email,
        clientName: ctx.client_name,
        businessName,
        serviceName,
        dateLabel,
        timeLabel,
        // The raw row feeds the add-to-calendar .ics attachment + links.
        inviteRow: ctx,
        notes: ctx.notes,
        // The service's "Prep instructions" (what to do or bring) - the
        // service editor promises these go out with the confirmation.
        prepInstructions: ctx.prep_instructions || null,
        videoRoomUrl: ctx.location_type === 'virtual' && ctx.location_label
          ? ctx.location_label
          : ctx.video_room_url,
        // Mobile bookings carry the address the client supplied. In-person
        // bookings fall back to the service's saved venue ("My home studio",
        // "123 Main St"). Either way, surfaces in the "Where" row.
        locationAddress: ctx.location_address || (ctx.location_type === 'in_person' ? ctx.location_label : null),
        source,
        branding,
        packageNote: packageNoteFor(ctx),
        extraNote,
        depositPayUrl,
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

    // 3. Notification email to owner - only for bookings a client made
    //    (owner manually adding a booking already knows it happened).
    if (clientMade && ctx.owner_email) {
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
        shopLine,
      }));
    }

    // 4. Push notification to owner - same gating as the email (bookings
    //    a client made), plus a waitlist auto-fill so the owner knows the
    //    freed slot was taken. Deep-links to the booking's drawer. The
    //    business's very first client booking already pushed "Your first
    //    booking is in." (firstWin above), so it is not pushed twice.
    if ((clientMade || source === 'waitlist') && !firstWin) {
      tasks.push(notifyOwnerSafe({
        workspaceId,
        type: 'bookings',
        payload: {
          title: source === 'waitlist' ? 'Spot filled from your waitlist' : 'New booking',
          body: `${ctx.client_name || 'A client'} · ${serviceName} · ${dateLabel} ${fmtTime(ctx.start_min)}${shopLine ? ` · ${shopLine}` : ''}`,
          url: `/calendar?booking=${ctx.id}`,
          tag: `booking-${ctx.id}`,
        },
      }));
    }

    // 4b. Push to the client when the business booked them (owner, helper
    //     or Ivy). No-op unless they claimed their portal and allow
    //     booking pushes. Client-made bookings skip it (they just did it),
    //     and waitlist promotions get their own push in waitlist.js.
    if ((source === 'owner' || source === 'request_approved') && ctx.client_id) {
      tasks.push(notifyClientSafe({
        clientId: ctx.client_id,
        type: 'bookings',
        payload: {
          title: source === 'request_approved' ? `${businessName} confirmed your booking` : `Booked with ${businessName}`,
          body: `${serviceName} · ${dateLabel} at ${fmtTime(ctx.start_min)}`,
          url: '/me/bookings',
          tag: `booking-${ctx.id}`,
        },
      }));
    }

    // 5. The helper this booking is assigned to (if they have a login) -
    //    whoever created it. Their shell deep-links to the day.
    if (ctx.staff_id) {
      tasks.push(notifyHelperSafe({
        workspaceId, staffId: ctx.staff_id,
        type: 'bookings',
        payload: {
          title: 'New booking for you',
          body: `${ctx.client_name || 'A client'} · ${serviceName} · ${dateLabel} ${fmtTime(ctx.start_min)}`,
          url: `/helper?date=${dateISO}`,
          tag: `helper-booking-${ctx.id}`,
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

// One modest line for a confirmation paid with a package session: the
// sessions left, or on the last one "That was your last session in X.
// Buy again: <link>". Only the newest booking of a batch carries it, so a
// four-session booking doesn't send four "last session" lines.
export function packageNoteFor(ctx) {
  if (!ctx?.client_package_id || !ctx.package_name || !ctx.package_latest) return null;
  const left = Number(ctx.package_remaining);
  if (!Number.isFinite(left)) return null;
  const base = appUrl();
  const slug = ctx.slug ? encodeURIComponent(ctx.slug) : null;
  if (left <= 0) {
    const buyUrl = slug && ctx.package_buyable && ctx.package_template_id
      ? `${base}/book/${slug}?buy=${encodeURIComponent(ctx.package_template_id)}`
      : (slug ? `${base}/book/${slug}` : null);
    return { last: true, name: ctx.package_name, left: 0, url: buyUrl, canBuy: !!(slug && ctx.package_buyable) };
  }
  return { last: false, name: ctx.package_name, left, url: null, canBuy: false };
}

function renderPackageNote(note) {
  if (!note) return '';
  if (note.last) {
    const link = note.url
      ? ` ${note.canBuy ? 'Buy again' : 'See all services'}: <a href="${escapeHtml(note.url)}" style="color:#2E3168;">${escapeHtml(note.url)}</a>`
      : '';
    return `<p style="margin:14px 0;">That was your last session in <strong>${escapeHtml(note.name)}</strong>.${link}</p>`;
  }
  return `<p style="margin:14px 0;">Paid with your <strong>${escapeHtml(note.name)}</strong> package. ${note.left} session${note.left === 1 ? '' : 's'} left.</p>`;
}

async function sendClientConfirm({ clientId, workspaceId, to, clientName, businessName, serviceName, dateLabel, timeLabel, notes, source, branding, videoRoomUrl, locationAddress, inviteRow, prepInstructions, packageNote = null, extraNote = null, depositPayUrl = null }) {
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
  // Add-to-calendar: a Google deep link + a signed .ics URL in the body,
  // plus the same .ics as an attachment (METHOD:REQUEST, stable UID) so
  // every mail client has a one-tap path. Best-effort - a bad row just
  // means the email ships without them.
  let calendarLinks = null;
  let attachments;
  if (inviteRow && inviteRow.date && inviteRow.start_min != null && inviteRow.end_min != null) {
    try {
      calendarLinks = calendarLinksFor(inviteRow);
      const ics = buildInviteIcs(inviteRow);
      attachments = [{
        filename: 'booking.ics',
        content: Buffer.from(ics, 'utf8').toString('base64'),
        contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
      }];
    } catch { /* skip the attachment + links, still send the email */ }
  }
  const opener = source === 'public'
    ? `Your booking with <strong>${escapeHtml(businessName)}</strong> is confirmed.`
    : source === 'request_approved'
      ? `Good news: <strong>${escapeHtml(businessName)}</strong> confirmed your booking request.`
      : `<strong>${escapeHtml(businessName)}</strong> just booked you in.`;
  const noteHtml = extraNote
    ? `<p style="margin:14px 0;padding:12px 14px;background:#F6F5F1;border:1px solid #E8E4DC;border-radius:10px;"><strong>A note from ${escapeHtml(businessName)}:</strong><br/>${escapeHtml(extraNote)}</p>`
    : '';
  const depositHtml = depositPayUrl
    ? `<p style="margin:14px 0;"><strong>One more step:</strong> your deposit is still due. <a href="${escapeHtml(depositPayUrl)}" style="color:#2E3168;">Pay the deposit</a> to lock in your spot.</p>`
    : '';
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
      ${noteHtml}
      ${depositHtml}
      ${renderPackageNote(packageNote)}
      ${renderAddToCalendar(calendarLinks)}
      ${renderPrepInstructions(prepInstructions)}
      <p>Need to reschedule or message ${escapeHtml(businessName)}? ${hasPortal
        ? 'You can view this booking and chat with them through your Ivy portal.'
        : 'Create a free Ivy portal account to see this booking, future visits, invoices, and messages from them in one place.'}</p>`,
    ctaText: portalCtaText,
    ctaUrl: portalUrl,
    footer: `If you didn't make this booking, please reach out to ${escapeHtml(businessName)} directly.`,
    branding,
  });
  await sendEmailToClient({
    clientId, workspaceId, type: 'bookings',
    to, subject: `Booking confirmed - ${dateLabel}`, html, replyTo: branding?.replyTo,
    attachments,
  });
}

async function sendOwnerNotify({ ownerId, to, ownerName, clientName, clientEmail, serviceName, dateLabel, timeLabel, notes, branding, shopLine = null }) {
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
      ${shopLine ? `<p>${escapeHtml(shopLine)}.</p>` : ''}
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

// "Before your appointment" block for the service's prep_instructions.
// Owners write these as a short list, one item per line, so line breaks
// are preserved. Empty/whitespace → nothing rendered. Shared with the
// reminder cron so the confirmation and the reminder say the same thing.
export function renderPrepInstructions(text) {
  const t = (text || '').toString().trim();
  if (!t) return '';
  return `<div style="margin:18px 0;padding:12px 14px;background:#F6F5F1;border:1px solid #E8E4DC;border-radius:10px;font-size:14px;line-height:1.55;">
        <strong>Before your appointment</strong><br/>
        <span style="white-space:pre-line;">${escapeHtml(t)}</span>
      </div>`;
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
export function notifyBookingCancellation(args) {
  return keepAlive(notifyBookingCancellationImpl(args));
}

async function notifyBookingCancellationImpl({ workspaceId, bookingId, occurrenceDate = null, source = 'owner' }) {
  try {
    const { rows } = await sql`
      SELECT
        b.id, b.client_id, b.client_name, b.client_email,
        b.date, b.start_min, b.end_min, b.staff_id,
        s.name AS service_name,
        cs.biz_name,
        w.owner_id,
        u.email AS owner_email, u.name AS owner_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN workspaces w ON w.id = b.workspace_id
      LEFT JOIN users u ON u.id = w.owner_id
      LEFT JOIN client_packages pk ON pk.id = b.client_package_id AND pk.workspace_id = b.workspace_id
      LEFT JOIN packages pt ON pt.id = pk.package_id AND pt.workspace_id = b.workspace_id
      WHERE b.id = ${bookingId}
    `;
    const ctx = rows[0];
    if (!ctx) return;

    const dateISO = occurrenceDate
      || (ctx.date instanceof Date ? ctx.date.toISOString().slice(0, 10) : ctx.date);
    const businessName = ctx.biz_name || 'Your business';
    const serviceName = ctx.service_name || 'Session';
    const dateLabel = fmtDate(dateISO);
    const timeLabel = `${fmtTime(ctx.start_min)} to ${fmtTime(ctx.end_min)}`;
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
        clientId: ctx.client_id, workspaceId,
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

    // Owner-side push when someone else cancelled (the client, or any
    // non-owner path). An owner who cancels from their own phone used to
    // get a push about their own tap; the bell row would duplicate it too.
    if (source !== 'owner') {
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
    // The assigned helper loses a session off their day.
    if (ctx.staff_id) {
      tasks.push(notifyHelperSafe({
        workspaceId, staffId: ctx.staff_id,
        type: 'bookings',
        payload: {
          title: 'Booking cancelled',
          body: `${ctx.client_name || 'Client'} · ${serviceName} · ${dateLabel} ${fmtTime(ctx.start_min)}`,
          url: `/helper?date=${dateISO}`,
          tag: `helper-booking-cancel-${ctx.id}-${dateISO}`,
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

async function sendCancellationToClient({ clientId, workspaceId, to, clientName, businessName, serviceName, dateLabel, timeLabel, branding }) {
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
    clientId, workspaceId, type: 'bookings',
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
export function notifyBookingRescheduled(args) {
  return keepAlive(notifyBookingRescheduledImpl(args));
}

async function notifyBookingRescheduledImpl({ workspaceId, bookingId, oldDateISO, oldStartMin, oldEndMin, source = 'owner' }) {
  try {
    const { rows } = await sql`
      SELECT
        b.id, b.client_id, b.client_name, b.client_email,
        b.date, b.start_min, b.end_min, b.staff_id,
        b.video_room_url, b.location_address, b.created_at, b.updated_at,
        s.name AS service_name, s.location_type, s.location_label,
        cs.biz_name, cs.timezone,
        w.owner_id,
        u.email AS owner_email, u.name AS owner_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN workspaces w ON w.id = b.workspace_id
      LEFT JOIN users u ON u.id = w.owner_id
      LEFT JOIN client_packages pk ON pk.id = b.client_package_id AND pk.workspace_id = b.workspace_id
      LEFT JOIN packages pt ON pt.id = pk.package_id AND pt.workspace_id = b.workspace_id
      WHERE b.id = ${bookingId}
    `;
    const ctx = rows[0];
    if (!ctx) return;

    const businessName = ctx.biz_name || 'Your business';
    const serviceName  = ctx.service_name || 'Session';
    const newDateISO   = ctx.date instanceof Date ? ctx.date.toISOString().slice(0, 10) : ctx.date;
    const newDate      = fmtDate(newDateISO);
    const newTime      = `${fmtTime(ctx.start_min)} to ${fmtTime(ctx.end_min)}`;
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
        clientId: ctx.client_id, workspaceId,
        to: ctx.client_email, clientName: ctx.client_name,
        businessName, serviceName,
        newDate, newTime, oldDate, oldTime, branding,
        inviteRow: ctx,
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

    // Owner push only when someone else moved it (same rule as cancels).
    if (source !== 'owner') {
      tasks.push(notifyOwnerSafe({
        workspaceId,
        type: 'bookings',
        payload: {
          title: source === 'client' ? 'Booking rescheduled by client' : 'Booking rescheduled',
          body: `${ctx.client_name || 'Client'} · ${serviceName} · ${newDate} ${fmtTime(ctx.start_min)}`,
          url: `/calendar?booking=${ctx.id}`,
          tag: `booking-reschedule-${ctx.id}`,
        },
      }));
    }
    // Client push when the business moved it - the email alone can sit
    // unread while the old time is still in their head.
    if (source === 'owner' && ctx.client_id) {
      tasks.push(notifyClientSafe({
        clientId: ctx.client_id,
        type: 'bookings',
        payload: {
          title: 'Appointment moved',
          body: `${businessName} moved ${serviceName} to ${newDate} at ${fmtTime(ctx.start_min)}`,
          url: '/me/bookings',
          tag: `booking-reschedule-${ctx.id}`,
        },
      }));
    }
    if (ctx.staff_id) {
      tasks.push(notifyHelperSafe({
        workspaceId, staffId: ctx.staff_id,
        type: 'bookings',
        payload: {
          title: 'Booking moved',
          body: `${ctx.client_name || 'Client'} · ${serviceName} · ${newDate} ${fmtTime(ctx.start_min)}`,
          url: `/helper?date=${newDateISO}`,
          tag: `helper-booking-reschedule-${ctx.id}`,
        },
      }));
    }

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

async function sendRescheduleToClient({ clientId, workspaceId, to, clientName, businessName, serviceName, newDate, newTime, oldDate, oldTime, branding, inviteRow }) {
  const greeting = clientName ? `Hi ${escapeHtml(clientName.split(/\s+/)[0])},` : 'Hi,';
  // Same UID as the confirmation's invite with a higher SEQUENCE, so
  // importing this one moves the event the client already saved.
  let calendarLinks = null;
  let attachments;
  if (inviteRow && inviteRow.date && inviteRow.start_min != null && inviteRow.end_min != null) {
    try {
      calendarLinks = calendarLinksFor(inviteRow);
      const ics = buildInviteIcs(inviteRow);
      attachments = [{
        filename: 'booking.ics',
        content: Buffer.from(ics, 'utf8').toString('base64'),
        contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
      }];
    } catch { /* still send the email */ }
  }
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
      </table>
      ${renderAddToCalendar(calendarLinks)}
      <p style="font-size:12.5px;color:#85827B;">Already saved the old time? Importing the attached invite updates it in place.</p>`,
    ctaText: 'Open my portal',
    ctaUrl: `${appUrl()}/me/bookings`,
    footer: `Reach out to ${escapeHtml(businessName)} if this new time doesn't work.`,
  });
  await sendEmailToClient({
    clientId, workspaceId, type: 'bookings',
    to, subject: `Rescheduled: ${serviceName} → ${newDate}`, html, replyTo: branding?.replyTo,
    attachments,
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

// The owner (re)assigned an existing booking to a helper: tell that
// helper it is now on their day. Same payload as a new assigned booking.
// No-op for staff without a login. Never throws.
export function notifyHelperAssigned({ workspaceId, bookingId }) {
  return keepAlive((async () => {
    try {
      const { rows } = await sql`
        SELECT b.id, b.staff_id, b.client_name, b.date, b.start_min, s.name AS service_name
          FROM bookings b
          LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
         WHERE b.id = ${bookingId} AND b.workspace_id = ${workspaceId} AND b.cancelled_at IS NULL`;
      const ctx = rows[0];
      if (!ctx?.staff_id) return;
      const dateISO = ctx.date instanceof Date ? ctx.date.toISOString().slice(0, 10) : ctx.date;
      await notifyHelperSafe({
        workspaceId, staffId: ctx.staff_id,
        type: 'bookings',
        payload: {
          title: 'New booking for you',
          body: `${ctx.client_name || 'A client'} · ${ctx.service_name || 'Session'} · ${fmtDate(dateISO)} ${fmtTime(ctx.start_min)}`,
          url: `/helper?date=${dateISO}`,
          tag: `helper-booking-${ctx.id}`,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[notifyHelperAssigned] failed:', err.message);
    }
  })());
}
