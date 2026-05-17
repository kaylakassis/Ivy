// /api/cron/booking-reminders — hourly job. For every upcoming non-cancelled
// booking, walks the service's reminder_minutes[] (default {10080, 2880,
// 1440, 120} = 1 week, 2 days, 1 day, 2 hours). If now() is within a
// (target - 70min, target + 5min] window for a beat that hasn't been sent
// yet, fires the reminder email and stamps reminders_sent[<minutes>].
//
// Auth: same as welcome-emails — Authorization: Bearer $CRON_SECRET from
// Vercel cron, OR x-admin-secret for manual testing.
//
// TZ caveat: bookings.date + start_min are treated as UTC for the math.
// For v1 this is good enough — reminders fire within the right hour even
// if the workspace's local timezone differs. We can layer
// calendar_settings.timezone on top later.
import { sql } from '../_lib/db.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import { sendClientSms } from '../_lib/sms.js';
import { appUrl } from '../_lib/tokens.js';
import { reportError } from '../_lib/monitoring.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { notifyClientSafe } from '../_lib/push.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';

// Per-run cap so a backlog (cron paused for a day, etc.) doesn't blow
// past Resend's rate limit on resume. The next tick catches the rest.
// Cron now fires every 10 min (see vercel.json), so 1000/tick = ~6K/hour
// throughput, comfortably covering 10K owners worth of daily reminders.
const MAX_PER_RUN = 1000;

// Window constants (minutes). The lookback covers a couple of skipped
// runs (an outage of up to ~20 minutes self-heals at the new 10-min
// cadence). The lookahead absorbs cron timing slop (Vercel doesn't
// fire exactly on schedule).
const LOOKBACK_MIN  = 25;
const LOOKAHEAD_MIN = 5;

export default async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  // Third path: signed-in super-admin clicking the in-app trigger button.
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    await ensureSchemaApplied();
    const now = Date.now();

    // Pull every active booking up to 8 days out + its service's reminder
    // schedule + the business name. 8 days covers the longest default
    // reminder beat (1 week) plus a buffer.
    const { rows } = await sql`
      SELECT
        b.id, b.workspace_id, b.client_id, b.client_email, b.client_name,
        COALESCE(b.client_phone, c.phone) AS client_phone,
        c.sms_consent_at,
        b.date, b.start_min, b.end_min, b.notes,
        b.reminders_sent, b.sms_sent,
        s.name AS service_name,
        COALESCE(s.reminder_minutes, ARRAY[]::int[]) AS reminder_minutes,
        cs.biz_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      LEFT JOIN clients c ON c.id = b.client_id
      WHERE b.cancelled_at IS NULL
        AND (
          (b.client_email IS NOT NULL AND b.client_email <> '')
          OR (COALESCE(b.client_phone, c.phone) IS NOT NULL AND c.sms_consent_at IS NOT NULL)
        )
        AND b.date BETWEEN CURRENT_DATE - INTERVAL '1 day'
                       AND CURRENT_DATE + INTERVAL '8 days'
      ORDER BY b.date, b.start_min
      LIMIT 5000
    `;

    let sent = 0;
    let scanned = 0;
    let failed = 0;
    for (const r of rows) {
      if (sent >= MAX_PER_RUN) break;
      scanned++;
      const dateISO = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date;
      const startMs = Date.parse(`${dateISO}T00:00:00Z`) + r.start_min * 60 * 1000;
      if (Number.isNaN(startMs)) continue;
      // Don't send reminders for bookings that have already started.
      if (startMs <= now) continue;

      const alreadyEmail = r.reminders_sent || {};
      const alreadySms   = r.sms_sent || {};
      const reminderMinutes = Array.isArray(r.reminder_minutes) ? r.reminder_minutes : [];
      const smsEligible = !!(r.client_phone && r.sms_consent_at);
      const emailEligible = !!(r.client_email);

      for (const mins of reminderMinutes) {
        if (sent >= MAX_PER_RUN) break;
        const minsNum = Number(mins);
        if (!Number.isFinite(minsNum) || minsNum <= 0) continue;
        const key = String(minsNum);

        const targetMs = startMs - minsNum * 60 * 1000;
        const diffMin = (now - targetMs) / 60000;
        if (diffMin < -LOOKAHEAD_MIN) continue; // too early
        if (diffMin >  LOOKBACK_MIN)  continue; // too late, skip silently

        // Email path. Decoupled from SMS so a Twilio failure doesn't
        // re-fire the email on the next cron tick (and vice versa).
        if (emailEligible && !alreadyEmail[key]) {
          try {
            const branding = await fetchBranding(r.workspace_id);
            await sendReminder({
              to: r.client_email,
              clientId: r.client_id,
              clientName: r.client_name,
              serviceName: r.service_name || 'Session',
              businessName: r.biz_name || 'Your business',
              dateISO,
              startMin: r.start_min,
              endMin: r.end_min,
              reminderMinutes: minsNum,
              notes: r.notes,
              branding,
            });
            await sql`
              UPDATE bookings
              SET reminders_sent = reminders_sent || jsonb_build_object(${key}, NOW()::text)
              WHERE id = ${r.id}
            `;
            // Push reminder to the client too (no-op if they haven't
            // claimed the portal or enabled push). Idempotency rides on
            // the reminders_sent stamp above — we only get here once.
            if (r.client_id) {
              await notifyClientSafe({
                clientId: r.client_id,
                type: 'bookings',
                payload: {
                  title: `Reminder: ${r.service_name || 'Session'} ${describeWindow(minsNum)}`,
                  body: `${r.biz_name || 'Your business'} · ${fmtDay(dateISO)} at ${fmtTime(r.start_min)}`,
                  url: `/me`,
                  tag: `reminder-${r.id}-${key}`,
                },
              });
            }
            sent++;
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[booking-reminder ${r.id}/${key}] email failed:`, err.message);
            reportError(err, { extra: { bookingId: r.id, beat: key, channel: 'email' } });
            failed++;
          }
        }

        // SMS path. Re-checks consent + phone (sendClientSms enforces).
        if (smsEligible && !alreadySms[key]) {
          const body = composeReminderSms({
            clientName: r.client_name,
            serviceName: r.service_name || 'Session',
            businessName: r.biz_name || 'Your business',
            dateISO,
            startMin: r.start_min,
            reminderMinutes: minsNum,
          });
          const out = await sendClientSms({
            phone:       r.client_phone,
            consentAt:   r.sms_consent_at,
            body,
            workspaceId: r.workspace_id, // gates the daily per-workspace SMS cap
          });
          if (out.ok) {
            await sql`
              UPDATE bookings
              SET sms_sent = sms_sent || jsonb_build_object(${key}, NOW()::text)
              WHERE id = ${r.id}
            `;
            sent++;
          } else {
            // eslint-disable-next-line no-console
            console.warn(`[booking-reminder ${r.id}/${key}] sms skipped: ${out.reason}`);
            // Don't bump `failed` for benign skip reasons; only if Twilio
            // returned an actual error from a configured account.
            if (!/no consent|no phone|invalid phone|twilio not configured/i.test(out.reason)) {
              failed++;
            }
          }
        }
      }
    }

    return ok(res, { ok: true, scanned, sent, failed });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

function fmtDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}
function describeWindow(mins) {
  if (mins >= 60 * 24 * 7) return `in ${Math.round(mins / (60 * 24 * 7))} week${mins >= 60 * 24 * 14 ? 's' : ''}`;
  if (mins >= 60 * 24)     return `in ${Math.round(mins / (60 * 24))} day${mins >= 60 * 48 ? 's' : ''}`;
  if (mins >= 60)          return `in ${Math.round(mins / 60)} hour${mins >= 120 ? 's' : ''}`;
  return `in ${mins} minute${mins === 1 ? '' : 's'}`;
}

async function sendReminder({ to, clientId, clientName, serviceName, businessName, dateISO, startMin, endMin, reminderMinutes, notes, branding }) {
  const greeting = clientName ? `Hi ${escapeHtml(clientName.split(/\s+/)[0])},` : 'Hi,';
  const when = describeWindow(reminderMinutes);
  const html = emailShell({
    heading: `Reminder: your appointment is ${when}`,
    body: `<p>${greeting}</p>
      <p>Just a heads up — you have an appointment with
        <strong>${escapeHtml(businessName)}</strong> ${when}.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(fmtDay(dateISO))}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(fmtTime(startMin))} – ${escapeHtml(fmtTime(endMin))}</td></tr>
        ${notes ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;vertical-align:top;">Note</td><td style="padding:6px 0;">${escapeHtml(notes)}</td></tr>` : ''}
      </table>
      <p>Need to reschedule or message ${escapeHtml(businessName)}? Open your portal —
      you can chat with them directly.</p>`,
    ctaText: 'Open my portal',
    ctaUrl: `${appUrl()}/me`,
    footer: `Reminder sent automatically. If you weren't expecting this email, please reach out to ${escapeHtml(businessName)}.`,
    branding,
  });
  return sendEmailToClient({
    clientId, type: 'bookings',
    to,
    subject: `Reminder: ${serviceName} ${when} — ${fmtDay(dateISO)}`,
    html,
    replyTo: branding?.replyTo,
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// SMS bodies need to fit in a couple of segments — keep punchy. The
// "Reply STOP to opt out" suffix is appended by withOptOutSuffix in
// _lib/sms.js; don't add it here.
function composeReminderSms({ clientName, serviceName, businessName, dateISO, startMin, reminderMinutes }) {
  const first = clientName ? clientName.split(/\s+/)[0] : 'there';
  const when  = describeWindow(reminderMinutes);
  const day   = new Date(dateISO + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const time  = fmtTime(startMin);
  return `${businessName}: hi ${first}, your ${serviceName} is ${when} (${day} at ${time}). See you then!`;
}
