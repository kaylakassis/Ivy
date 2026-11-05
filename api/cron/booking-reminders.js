// /api/cron/booking-reminders - every 10 minutes (vercel.json). For every
// upcoming non-cancelled booking it works out two reminder schedules
// (api/_lib/reminderSettings.js):
//
//   • the CLIENT schedule: the client's own profile setting, else the
//     booked service's own schedule, else the business default
//     (calendar_settings.client_reminders, NULL = 1 day, 8 hours, 1 hour).
//     Off entirely when the business turned client reminders off or the
//     client turned them off in their portal. Sent by email (preference
//     gated), text (consent + STOP respected) and push, per the business's
//     channel choices. Claims: reminders_sent / sms_sent / push_sent.
//   • the TEAM schedule: the owner's own heads-up
//     (calendar_settings.owner_reminders, NULL = 1 day and 1 hour), by
//     email and push. A booking assigned to a helper with a login reminds
//     that helper by push instead. Claim map: owner_reminders_sent.
//
// A beat (N minutes before the start) fires when now is within
// (target - LOOKAHEAD, target + LOOKBACK]. With a 10 minute cadence and a
// 30 minute wide window every beat, 30 minutes and 1 hour included, is
// seen by at least two ticks and sent by the first one (the claim makes
// it once only). Beats whose time passed before the booking existed, or
// longer ago than the lookback (a schedule changed after booking), are
// never sent, so a change never floods anyone. When several beats are due
// at once (a late booking), only the nearest one is sent and the others
// are marked 'skipped'.
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
import { sendEmailToClient, sendEmailToUser, emailShell } from '../_lib/email.js';
import { makeBrandingCache } from '../_lib/branding.js';
import { sendClientSms } from '../_lib/sms.js';
import { appUrl } from '../_lib/tokens.js';
import { reportError } from '../_lib/monitoring.js';
import { cronAuthorized } from '../_lib/cronAuth.js';
import { notifyClientSafe, notifyHelperSafe, notifyOwnerSafe } from '../_lib/push.js';
import { renderPrepInstructions } from '../_lib/bookingNotify.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { shardFromReq, shardClause, withDeadline, terminationReason } from '../_lib/cronShard.js';
import {
  clientBeatsSql, ownerBeatsSql, clientRemindersFrom, ownerRemindersFrom,
} from '../_lib/reminderSettings.js';

// Soft per-run safety ceiling. The deadline loop is the primary brake —
// it stops calling fetchDueBookings the moment we approach Vercel's 300s
// function cap, well before Resend's per-account rate limit becomes the
// bottleneck. This cap remains as a paranoia rail in case a deadline
// miscalculation lets a runaway loop slip through. Real per-tick
// throughput is ~250 sends/min sustained (8/sec Resend throttle × 4min
// usable budget = ~2000) so this is generous.
const SAFETY_PER_RUN = 8000;

// Window constants (minutes). The lookback covers a couple of skipped
// runs (an outage of up to ~20 minutes self-heals at the 10-min
// cadence). The lookahead absorbs cron timing slop (Vercel doesn't
// fire exactly on schedule).
export const LOOKBACK_MIN  = 25;
export const LOOKAHEAD_MIN = 5;
// A beat whose time had already passed (by more than this) when the
// booking was made is not sent: the client just booked and got the
// confirmation.
const CREATED_SLACK_MIN = 10;

// Page size for the keyset scan.
const SCAN_BATCH = 1000;
// SQL pre-filter window (minutes). Deliberately WIDER than the JS
// LOOKBACK/LOOKAHEAD so the pre-filter never excludes a booking the JS
// per-beat check would have reminded - the JS check is the source of truth.
const SQL_LOOKBACK_MIN  = 60;
const SQL_LOOKAHEAD_MIN = 15;

// Which beats of `beats` are due right now for a booking starting at
// startMs and created at createdMs. Returns { send, skip }: `send` is the
// one beat to send (the nearest, i.e. the smallest) or null; `skip` are
// the other due beats, to be marked so they never fire later. Pure, so the
// cadence tests can drive it with a fake clock.
export function pickDueBeat(beats, startMs, nowMs, createdMs = null) {
  const due = [];
  for (const b of beats || []) {
    const mins = Number(b);
    if (!Number.isFinite(mins) || mins <= 0) continue;
    const targetMs = startMs - mins * 60000;
    const diffMin = (nowMs - targetMs) / 60000;
    if (diffMin < -LOOKAHEAD_MIN) continue; // too early
    if (diffMin > LOOKBACK_MIN) continue;   // too late, skip silently
    if (createdMs != null && Number.isFinite(createdMs)
        && targetMs < createdMs - CREATED_SLACK_MIN * 60000) continue; // booked after this beat
    due.push(mins);
  }
  if (due.length === 0) return { send: null, skip: [] };
  due.sort((a, b) => a - b);
  return { send: due[0], skip: [...new Set(due.slice(1))] };
}

// One page of bookings that have at least one reminder beat (client or
// team) whose target time lands in a generous window around now. Keyset
// cursor over (date, start_min, id) so paging is stable and complete.
//
// `shardFilter` is the SQL fragment from shardClause() — empty string
// when unsharded (default) or ` AND ((hashtext(b.workspace_id::text) %
// N + N) % N) = K` when running under `?shard=K&shards=N`. The shard
// boundary is applied at fetch time so a fan-out of N cron entries
// processes disjoint workspace slices without overlap.
export async function fetchDueBookings(cursor, shardFilter = '') {
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
  const inWindow = (arr) => `EXISTS (
        SELECT 1 FROM unnest(${arr}) AS m
        WHERE m > 0 AND (${startTs} - make_interval(mins => m))
              BETWEEN NOW() - make_interval(mins => ${SQL_LOOKBACK_MIN})
                  AND NOW() + make_interval(mins => ${SQL_LOOKAHEAD_MIN}))`;
  const text = `
    SELECT
      b.id, b.workspace_id, b.client_id, b.client_email, b.client_name,
      COALESCE(b.client_phone, c.phone) AS client_phone,
      c.sms_consent_at, c.user_id AS client_user_id,
      b.date, b.start_min, b.end_min, b.notes, b.staff_id, b.created_at,
      b.reminders_sent, b.sms_sent, b.push_sent, b.owner_reminders_sent,
      s.name AS service_name, s.prep_instructions,
      cs.biz_name, cs.timezone, cs.client_reminders, cs.owner_reminders,
      ou.id AS owner_user_id, ou.email AS owner_email,
      hu.id AS helper_user_id,
      rb.client_beats, rb.owner_beats
    FROM bookings b
    JOIN workspaces w ON w.id = b.workspace_id
    LEFT JOIN users ou ON ou.id = w.owner_id AND ou.deleted_at IS NULL
    LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
    LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
    LEFT JOIN clients c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
    LEFT JOIN staff_members sm ON sm.id = b.staff_id AND sm.workspace_id = b.workspace_id
          AND sm.active = TRUE AND sm.user_id IS NOT NULL AND sm.user_id <> w.owner_id
    LEFT JOIN users hu ON hu.id = sm.user_id AND hu.deleted_at IS NULL
    CROSS JOIN LATERAL (
      SELECT ${clientBeatsSql()} AS client_beats, ${ownerBeatsSql()} AS owner_beats
    ) rb
    WHERE b.cancelled_at IS NULL
      AND b.date BETWEEN (NOW() AT TIME ZONE COALESCE(cs.timezone, 'UTC'))::date - INTERVAL '1 day'
                     AND (NOW() AT TIME ZONE COALESCE(cs.timezone, 'UTC'))::date + INTERVAL '8 days'
      AND (
        (
          (
            (b.client_email IS NOT NULL AND b.client_email <> '')
            OR (COALESCE(b.client_phone, c.phone) IS NOT NULL AND c.sms_consent_at IS NOT NULL)
            OR c.user_id IS NOT NULL
          )
          AND ${inWindow('rb.client_beats')}
        )
        OR ((ou.id IS NOT NULL OR hu.id IS NOT NULL) AND ${inWindow('rb.owner_beats')})
      )
      ${cursorClause}
      ${shardFilter}
    ORDER BY b.date, b.start_min, b.id
    LIMIT ${SCAN_BATCH}
  `;
  return sql.query(text, params);
}

// Mark beats as 'skipped' in the given claim maps without overwriting a
// real send stamp. 'skipped' is not a timestamp, so the weekly recap's
// reminder count ignores it.
async function markSkipped(bookingId, columns, beats) {
  if (!beats.length) return;
  const obj = JSON.stringify(Object.fromEntries(beats.map((m) => [String(m), 'skipped'])));
  const sets = columns.map((col) => `${col} = $2::jsonb || ${col}`).join(', ');
  await sql.query(`UPDATE bookings SET ${sets} WHERE id = $1`, [bookingId, obj]).catch(() => {});
}

// Atomically claim one beat in one claim map. Only the run that adds the
// key proceeds, so overlapping runs can never double-send.
async function claim(bookingId, column, key) {
  const r = await sql.query(
    `UPDATE bookings SET ${column} = ${column} || jsonb_build_object($2::text, NOW()::text)
      WHERE id = $1 AND NOT (${column} ? $2) RETURNING id`,
    [bookingId, key],
  );
  return r.rowCount > 0;
}
async function release(bookingId, column, key) {
  await sql.query(`UPDATE bookings SET ${column} = ${column} - $2::text WHERE id = $1`, [bookingId, key])
    .catch(() => {});
}

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);

  try {
    await ensureSchemaApplied();
    const now = Date.now();

    const { shard, shards } = shardFromReq(req);
    const shardFilter = shardClause({ shard, shards }, 'b.workspace_id');

    let sent = 0;
    let ownerSent = 0;
    let scanned = 0;
    let failed = 0;
    let batches = 0;
    // Memoize branding per workspace for this run - many reminders share
    // the same handful of workspaces.
    const getBranding = makeBrandingCache();

    // Keyset-paginate the candidate set across as many pages as the
    // deadline allows: until (a) the candidate set drains, (b) the
    // function approaches its 5min Vercel cap (deadline), or (c) the
    // paranoia ceiling SAFETY_PER_RUN is reached.
    let cursor = null;
    let more = true;
    let stop = false;
    await withDeadline(async (deadline) => {
      while (more && sent < SAFETY_PER_RUN && !stop && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await fetchDueBookings(cursor, shardFilter);
        if (rows.length === 0) break;
        const last = rows[rows.length - 1];
        cursor = { date: last.date, startMin: last.start_min, id: last.id };
        more = rows.length === SCAN_BATCH;
        batches += 1;

        for (const r of rows) {
          if (sent >= SAFETY_PER_RUN || Date.now() >= deadline) { stop = true; break; }
          scanned++;
          // eslint-disable-next-line no-await-in-loop
          const out = await remindBooking(r, { now, getBranding });
          sent += out.sent; ownerSent += out.ownerSent; failed += out.failed;
        }
      }
    });

    // `more=false` after the last fetch means we drained the candidate
    // set; if `more` is still true AND we stopped, it was either the
    // deadline or the safety cap.
    const terminatedBy = terminationReason({
      emptied: !more,
      hitCap:  sent >= SAFETY_PER_RUN,
    });
    return ok(res, { ok: true, shard, shards, batches, scanned, sent, ownerSent, failed, terminatedBy });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

// Everything due for one candidate row from fetchDueBookings. Exported so
// tests can run it on their own rows only (the full cron walks every
// workspace in the database).
export async function remindBooking(r, { now = Date.now(), getBranding = makeBrandingCache() } = {}) {
  const dateISO = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date;
  const startMs = slotEpochMs(dateISO, r.start_min, r.timezone || null);
  // Don't send reminders for bookings that have already started.
  if (!Number.isFinite(startMs) || startMs <= now) return { sent: 0, ownerSent: 0, failed: 0 };
  const createdMs = r.created_at ? new Date(r.created_at).getTime() : null;
  const c = await remindClient({ r, dateISO, startMs, now, createdMs, getBranding });
  const o = await remindTeam({ r, dateISO, startMs, now, createdMs });
  return { sent: c.sent + o.sent, ownerSent: o.sent, failed: c.failed + o.failed };
}

// Client side of one booking: email, text and push, each claimed on its
// own so a failure on one channel never re-sends another.
async function remindClient({ r, dateISO, startMs, now, createdMs, getBranding }) {
  let sent = 0;
  let failed = 0;
  const beats = Array.isArray(r.client_beats) ? r.client_beats : [];
  const { send: mins, skip } = pickDueBeat(beats, startMs, now, createdMs);
  if (skip.length) await markSkipped(r.id, ['reminders_sent', 'sms_sent', 'push_sent'], skip);
  if (mins == null) return { sent, failed };

  const key = String(mins);
  const channels = clientRemindersFrom(r.client_reminders ?? null).channels;
  const leftMin = Math.max(1, Math.round((startMs - now) / 60000));
  const serviceName = r.service_name || 'Session';
  const businessName = r.biz_name || 'Your business';
  const alreadyEmail = r.reminders_sent || {};
  const alreadySms = r.sms_sent || {};
  const alreadyPush = r.push_sent || {};

  // Email (preference gated by sendEmailToClient: the client's Bookings
  // email switch and any unsubscribe are honoured there).
  if (channels.email && r.client_email && !alreadyEmail[key] && await claim(r.id, 'reminders_sent', key)) {
    try {
      const branding = await getBranding(r.workspace_id);
      await sendReminder({
        to: r.client_email,
        clientId: r.client_id, workspaceId: r.workspace_id,
        clientName: r.client_name,
        serviceName, businessName,
        dateISO,
        startMin: r.start_min,
        endMin: r.end_min,
        leftMinutes: leftMin,
        notes: r.notes,
        prepInstructions: r.prep_instructions,
        branding,
      });
      sent++;
    } catch (err) {
      // Release the claim so the next tick retries.
      await release(r.id, 'reminders_sent', key);
      // eslint-disable-next-line no-console
      console.error(`[booking-reminder ${r.id}/${key}] email failed:`, err.message);
      reportError(err, { extra: { bookingId: r.id, beat: key, channel: 'email' } });
      failed++;
    }
  }

  // Push to the client's own app (no-op unless they claimed the portal;
  // their push 'bookings' mute is honoured by sendPushToUser). Before
  // push_sent existed the push rode on the email claim, so an email stamp
  // from an earlier run means that beat's push already went.
  if (channels.push && r.client_id && r.client_user_id && !alreadyPush[key] && !alreadyEmail[key]
      && await claim(r.id, 'push_sent', key)) {
    await notifyClientSafe({
      clientId: r.client_id,
      type: 'bookings',
      payload: {
        title: `Reminder: ${serviceName} ${describeLeft(leftMin)}`,
        body: `${businessName} · ${fmtDay(dateISO)} at ${fmtTime(r.start_min)}`,
        url: `/me`,
        tag: `reminder-${r.id}-${key}`,
      },
    });
  }

  // Text. sendClientSms re-checks consent + phone; a STOP clears consent.
  const smsEligible = !!(r.client_phone && r.sms_consent_at);
  if (channels.sms && smsEligible && !alreadySms[key] && await claim(r.id, 'sms_sent', key)) {
    const body = composeReminderSms({
      clientName: r.client_name, serviceName, businessName,
      dateISO, startMin: r.start_min, leftMinutes: leftMin,
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
      await release(r.id, 'sms_sent', key);
      // eslint-disable-next-line no-console
      console.warn(`[booking-reminder ${r.id}/${key}] sms skipped: ${out.reason}`);
      if (!/no consent|no phone|invalid phone|twilio not configured/i.test(out.reason)) failed++;
    }
  }
  return { sent, failed };
}

// Team side of one booking: the assigned helper (push) when the booking
// has one with a login, otherwise the owner (email + push, per their
// channel choices). Independent of everything the client gets.
async function remindTeam({ r, dateISO, startMs, now, createdMs }) {
  let sent = 0;
  let failed = 0;
  const beats = Array.isArray(r.owner_beats) ? r.owner_beats : [];
  const { send: mins, skip } = pickDueBeat(beats, startMs, now, createdMs);
  if (skip.length) await markSkipped(r.id, ['owner_reminders_sent'], skip);
  if (mins == null) return { sent, failed };
  if (!r.helper_user_id && !r.owner_user_id) return { sent, failed };

  const key = String(mins);
  if ((r.owner_reminders_sent || {})[key]) return { sent, failed };
  const settings = ownerRemindersFrom(r.owner_reminders ?? null);
  const leftMin = Math.max(1, Math.round((startMs - now) / 60000));
  const serviceName = r.service_name || 'Appointment';
  const who = r.client_name || 'A client';
  const when = `${fmtDay(dateISO)} at ${fmtTime(r.start_min)}`;

  if (r.helper_user_id) {
    if (!(await claim(r.id, 'owner_reminders_sent', key))) return { sent, failed };
    await notifyHelperSafe({
      workspaceId: r.workspace_id, staffId: r.staff_id,
      type: 'bookings',
      payload: {
        title: `Coming up ${describeLeft(leftMin)}: ${serviceName}`,
        body: `${who} · ${when}`,
        url: `/helper?date=${dateISO}`,
        tag: `helper-reminder-${r.id}-${key}`,
      },
    });
    return { sent: 1, failed };
  }

  if (!settings.channels.email && !settings.channels.push) return { sent, failed };
  if (!(await claim(r.id, 'owner_reminders_sent', key))) return { sent, failed };
  if (settings.channels.push) {
    await notifyOwnerSafe({
      workspaceId: r.workspace_id,
      type: 'bookings',
      payload: {
        title: `Coming up ${describeLeft(leftMin)}: ${serviceName}`,
        body: `${who} · ${when}`,
        url: `/calendar?date=${dateISO}`,
        tag: `owner-reminder-${r.id}-${key}`,
      },
    });
    sent++;
  }
  if (settings.channels.email && r.owner_email) {
    const out = await sendOwnerReminder({
      userId: r.owner_user_id, to: r.owner_email,
      clientName: who, serviceName, dateISO,
      startMin: r.start_min, endMin: r.end_min, leftMinutes: leftMin, notes: r.notes,
    }).catch((err) => ({ ok: false, reason: err.message }));
    if (out?.ok === false) {
      failed++;
      // eslint-disable-next-line no-console
      console.error(`[booking-reminder ${r.id}/owner-${key}] email failed:`, out.reason);
    } else if (!settings.channels.push) {
      sent++;
    }
  }
  return { sent, failed };
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

// "in 1 hour", "in 8 hours", "in 1 day", "in 35 minutes": from the time
// really left, so a reminder sent a little late never reads wrong.
export function describeLeft(mins) {
  const m = Math.max(1, Math.round(Number(mins) || 0));
  if (m >= 60 * 24 * 7 - 60 * 6) {
    const w = Math.max(1, Math.round(m / (60 * 24 * 7)));
    return `in ${w} week${w === 1 ? '' : 's'}`;
  }
  if (m >= 60 * 23) {
    const d = Math.max(1, Math.round(m / (60 * 24)));
    return `in ${d} day${d === 1 ? '' : 's'}`;
  }
  if (m >= 55) {
    const h = Math.max(1, Math.round(m / 60));
    return `in ${h} hour${h === 1 ? '' : 's'}`;
  }
  const r = Math.max(5, Math.round(m / 5) * 5);
  return `in ${r} minutes`;
}

async function sendReminder({ to, clientId, workspaceId, clientName, serviceName, businessName, dateISO, startMin, endMin, leftMinutes, notes, prepInstructions, branding }) {
  const greeting = clientName ? `Hi ${escapeHtml(clientName.split(/\s+/)[0])},` : 'Hi,';
  const when = describeLeft(leftMinutes);
  const html = emailShell({
    heading: `Reminder: your appointment is ${when}`,
    body: `<p>${greeting}</p>
      <p>Just a heads up, you have an appointment with
        <strong>${escapeHtml(businessName)}</strong> ${when}.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(fmtDay(dateISO))}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(fmtTime(startMin))} to ${escapeHtml(fmtTime(endMin))}</td></tr>
        ${notes ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;vertical-align:top;">Note</td><td style="padding:6px 0;">${escapeHtml(notes)}</td></tr>` : ''}
      </table>
      ${renderPrepInstructions(prepInstructions)}
      <p>Need to reschedule or message ${escapeHtml(businessName)}? Open your portal,
      you can chat with them directly.</p>`,
    ctaText: 'Open my portal',
    ctaUrl: `${appUrl()}/me`,
    footer: `Reminder sent automatically. You can turn reminders off any time in your notification settings. If you weren't expecting this email, please reach out to ${escapeHtml(businessName)}.`,
    branding,
  });
  return sendEmailToClient({
    clientId, workspaceId, type: 'bookings',
    to,
    subject: `Reminder: ${serviceName} ${when}, ${fmtDay(dateISO)}`,
    html,
    replyTo: branding?.replyTo,
  });
}

// The owner's own heads-up. Gated on their 'bookings' email preference.
async function sendOwnerReminder({ userId, to, clientName, serviceName, dateISO, startMin, endMin, leftMinutes, notes }) {
  const when = describeLeft(leftMinutes);
  const html = emailShell({
    heading: `Coming up ${when}`,
    body: `<p>${escapeHtml(clientName)} is booked with you ${when}.</p>
      <table role="presentation" cellpadding="0" cellspacing="0"
        style="margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.55;">
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Client</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(clientName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Service</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Date</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(fmtDay(dateISO))}</td></tr>
        <tr><td style="padding:6px 16px 6px 0;color:#85827B;">Time</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(fmtTime(startMin))} to ${escapeHtml(fmtTime(endMin))}</td></tr>
        ${notes ? `<tr><td style="padding:6px 16px 6px 0;color:#85827B;vertical-align:top;">Note</td><td style="padding:6px 0;">${escapeHtml(notes)}</td></tr>` : ''}
      </table>`,
    ctaText: 'Open my calendar',
    ctaUrl: `${appUrl()}/calendar?date=${encodeURIComponent(dateISO)}`,
    footer: 'You can change when you get these, or turn them off, in Calendar > Reminders. Your clients\' reminders are set separately.',
  });
  return sendEmailToUser({
    userId, type: 'bookings', to,
    subject: `Coming up ${when}: ${clientName}, ${serviceName}`,
    html,
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// SMS bodies need to fit in a couple of segments - keep punchy. The
// "Reply STOP to opt out" suffix is appended by withOptOutSuffix in
// _lib/sms.js; don't add it here.
function composeReminderSms({ clientName, serviceName, businessName, dateISO, startMin, leftMinutes }) {
  const first = clientName ? clientName.split(/\s+/)[0] : 'there';
  const when  = describeLeft(leftMinutes);
  const day   = new Date(dateISO + 'T00:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const time  = fmtTime(startMin);
  return `${businessName}: hi ${first}, your ${serviceName} is ${when} (${day} at ${time}). See you then!`;
}

export default trackCron('booking-reminders', handler);
