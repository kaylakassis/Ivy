// /api/cron/booking-reminders - hourly job. For every upcoming non-cancelled
// booking, walks the service's reminder_minutes[] (default {10080, 2880,
// 1440, 120} = 1 week, 2 days, 1 day, 2 hours). If now() is within a
// (target - 70min, target + 5min] window for a beat that hasn't been sent
// yet, fires the reminder email and stamps reminders_sent[<minutes>].
//
// Auth: same as welcome-emails - Authorization: Bearer $CRON_SECRET from
// Vercel cron, OR x-admin-secret for manual testing.
//
// TZ correctness: bookings.(date, start_min) are wall-clock in the
// workspace's calendar_settings.timezone. Both the SQL prefilter and
// the per-row JS math convert to UTC using that timezone. A null tz
// falls back to UTC (legacy workspaces).
import { sql } from '../_lib/db.js';
import { slotEpochMs } from '../_lib/calendar.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { makeBrandingCache } from '../_lib/branding.js';
import { sendClientSms } from '../_lib/sms.js';
import { appUrl } from '../_lib/tokens.js';
import { reportError } from '../_lib/monitoring.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { notifyClientSafe } from '../_lib/push.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';

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

// Page size for the keyset scan.
const SCAN_BATCH = 1000;
// SQL pre-filter window (minutes). Deliberately WIDER than the JS
// LOOKBACK/LOOKAHEAD so the pre-filter never excludes a booking the JS
// per-beat check would have reminded - the JS check is the source of truth.
const SQL_LOOKBACK_MIN  = 60;
const SQL_LOOKAHEAD_MIN = 15;

// One page of bookings that have at least one reminder beat whose target
// time lands in a generous window around now. Keyset cursor over
// (date, start_min, id) so paging is stable and complete. Replaces the old
// single LIMIT 5000 scan that silently truncated busy installs.
export async function fetchDueBookings(cursor) {
  const params = [];
  let cursorClause = '';
  if (cursor) {
    cursorClause = `AND (b.date, b.start_min, b.id) > ($1, $2, $3)`;
    params.push(cursor.date, cursor.startMin, cursor.id);
  }
  // Booking start as a UTC instant - interpret (date, start_min) as
  // wall-clock in the workspace's IANA timezone. A null tz falls back
  // to UTC for legacy rows. This matches slotEpochMs() in JS so the
  // SQL prefilter and the per-row math agree.
  const startTs = `((b.date::timestamp + make_interval(mins => b.start_min)) AT TIME ZONE COALESCE(cs.timezone, 'UTC'))`;
  const text = `
    SELECT
      b.id, b.workspace_id, b.client_id, b.client_email, b.client_name,
      COALESCE(b.client_phone, c.phone) AS client_phone,
      c.sms_consent_at,
      b.date, b.start_min, b.end_min, b.notes,
      b.reminders_sent, b.sms_sent,
      s.name AS service_name,
      COALESCE(s.reminder_minutes, ARRAY[]::int[]) AS reminder_minutes,
      cs.biz_name, cs.timezone
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
      AND EXISTS (
        SELECT 1 FROM unnest(COALESCE(s.reminder_minutes, ARRAY[]::int[])) AS m
        WHERE (${startTs} - make_interval(mins => m))
              BETWEEN NOW() - make_interval(mins => ${SQL_LOOKBACK_MIN})
                  AND NOW() + make_interval(mins => ${SQL_LOOKAHEAD_MIN})
      )
      ${cursorClause}
    ORDER BY b.date, b.start_min, b.id
    LIMIT ${SCAN_BATCH}
  `;
  return sql.query(text, params);
}

async function handler(req, res) {
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

    let sent = 0;
    let scanned = 0;
    let failed = 0;
    // Memoize branding per workspace for this run - many reminders share
    // the same handful of workspaces.
    const getBranding = makeBrandingCache();

    // Keyset-paginate the candidate set instead of a single LIMIT 5000
    // scan. The old hard cap silently dropped reminders for every booking
    // past the first 5000 in the 8-day window once an install got busy -
    // entire tenants never got reminded. We now page through ALL due
    // bookings (bounded only by MAX_PER_RUN *sends*). fetchDueBookings
    // pre-filters in SQL to bookings with a beat landing in a generous
    // window around now, so each page stays small; the precise per-beat
    // ±window check below still runs in JS, so the wide SQL pre-filter can
    // never drop a booking we'd actually remind.
    let cursor = null;
    let more = true;
    while (more && sent < MAX_PER_RUN) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await fetchDueBookings(cursor);
      if (rows.length === 0) break;
      const last = rows[rows.length - 1];
      cursor = { date: last.date, startMin: last.start_min, id: last.id };
      more = rows.length === SCAN_BATCH;

      for (const r of rows) {
      if (sent >= MAX_PER_RUN) break;
      scanned++;
      const dateISO = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date;
      const startMs = slotEpochMs(dateISO, r.start_min, r.timezone || null);
      if (!Number.isFinite(startMs)) continue;
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
          // Atomically CLAIM this beat before sending so two overlapping
          // cron runs can't both pass the !alreadyEmail check and send the
          // same reminder twice. Only the run that adds the key (rowCount=1)
          // proceeds; if the send then fails we release the claim below so
          // the next tick retries.
          const claim = await sql`
            UPDATE bookings
            SET reminders_sent = reminders_sent || jsonb_build_object(${key}, NOW()::text)
            WHERE id = ${r.id} AND NOT (reminders_sent ? ${key})
            RETURNING id
          `;
          if (claim.rowCount > 0) {
          try {
            const branding = await getBranding(r.workspace_id);
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
            // Push reminder to the client too (no-op if they haven't
            // claimed the portal or enabled push). Idempotency rides on
            // the reminders_sent claim above - we only get here once.
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
            // Release the claim so the next tick retries (don't drop the
            // reminder just because this send failed).
            await sql`UPDATE bookings SET reminders_sent = reminders_sent - ${key} WHERE id = ${r.id}`
              .catch(() => {});
            // eslint-disable-next-line no-console
            console.error(`[booking-reminder ${r.id}/${key}] email failed:`, err.message);
            reportError(err, { extra: { bookingId: r.id, beat: key, channel: 'email' } });
            failed++;
          }
          }
        }

        // SMS path. Re-checks consent + phone (sendClientSms enforces).
        if (smsEligible && !alreadySms[key]) {
          // Atomically claim this SMS beat first (see email path). Released
          // below if the send is skipped/fails so a later tick can retry.
          const claim = await sql`
            UPDATE bookings
            SET sms_sent = sms_sent || jsonb_build_object(${key}, NOW()::text)
            WHERE id = ${r.id} AND NOT (sms_sent ? ${key})
            RETURNING id
          `;
          if (claim.rowCount > 0) {
            const body = composeReminderSms({
              clientName: r.client_name,
              serviceName: r.service_name || 'Session',
              businessName: r.biz_name || 'Your business',
              dateISO,
              startMin: r.start_min,
              reminderMinutes: minsNum,
            });
            let out;
            try {
              out = await sendClientSms({
                phone:       r.client_phone,
                consentAt:   r.sms_consent_at,
                body,
                workspaceId: r.workspace_id, // gates the daily per-workspace SMS cap
              });
            } catch (err) {
              out = { ok: false, reason: err.message || 'send error' };
            }
            if (out.ok) {
              sent++;
            } else {
              // Release the claim so a later tick can retry.
              await sql`UPDATE bookings SET sms_sent = sms_sent - ${key} WHERE id = ${r.id}`
                .catch(() => {});
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
      <p>Just a heads up - you have an appointment with
        <strong>${escapeHtml(businessName)}</strong> ${when}.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(fmtDay(dateISO))}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(fmtTime(startMin))} – ${escapeHtml(fmtTime(endMin))}</td></tr>
        ${notes ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;vertical-align:top;">Note</td><td style="padding:6px 0;">${escapeHtml(notes)}</td></tr>` : ''}
      </table>
      <p>Need to reschedule or message ${escapeHtml(businessName)}? Open your portal -
      you can chat with them directly.</p>`,
    ctaText: 'Open my portal',
    ctaUrl: `${appUrl()}/me`,
    footer: `Reminder sent automatically. If you weren't expecting this email, please reach out to ${escapeHtml(businessName)}.`,
    branding,
  });
  return sendEmailToClient({
    clientId, type: 'bookings',
    to,
    subject: `Reminder: ${serviceName} ${when} - ${fmtDay(dateISO)}`,
    html,
    replyTo: branding?.replyTo,
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// SMS bodies need to fit in a couple of segments - keep punchy. The
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

export default trackCron('booking-reminders', handler);
