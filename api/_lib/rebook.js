// One-tap rebook (1.0.6).
//
// A rebook link opens the business's booking page with the same service
// chosen and the calendar already on a suggested day: the same weekday as
// the client's last visit, N weeks later, where N is the client's own usual
// gap for that service (median days between their past visits, in whole
// weeks, 1 to 12). With fewer than two past visits, N is the service's
// typical gap across the business, else 4 weeks. The same time is
// preselected when it is free, else the nearest free time that day, else
// just the day. Everything here is computed on the server; the page only
// says "Your usual: every N weeks on Fridays" when it comes from that
// client's own history (usual: true), never otherwise.
//
// Links carry a signed token tied to workspace + client + service (no ids
// to enumerate, nothing to guess), expire after 90 days, and never carry
// or reveal client data. The public endpoint that resolves one
// (api/calendar/public/rebook.js) answers with the service, the suggested
// day and time, and nothing about the person.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { appUrl } from './tokens.js';
import { fetchCalendarSettings, effectiveWindows, hasConflict, slotEpochMs } from './calendar.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { sendClientSms } from './sms.js';
import { rateLimit } from './rate-limit.js';

export const REBOOK_TTL_DAYS = 90;
export const REBOOK_MIN_WEEKS = 1;
export const REBOOK_MAX_WEEKS = 12;
export const REBOOK_DEFAULT_WEEKS = 4;
// How often a client can be sent a rebook link (owner button, Ivy), and how
// many a business can send in an hour. Generous for a real owner, tight for
// a loop.
export const REBOOK_SEND_PER_CLIENT_PER_DAY = 2;
export const REBOOK_SEND_PER_WORKSPACE_PER_HOUR = 60;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── token ──────────────────────────────────────────────────────────────
function secretKey() {
  const explicit = process.env.REBOOK_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  const seed = `${process.env.JWT_SECRET || 'no-jwt-secret'}|${appUrl()}|ivy-rebook-v1`;
  return crypto.createHash('sha256').update(seed).digest('hex');
}
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
const sign = (body) => b64url(crypto.createHmac('sha256', secretKey()).update(body).digest());

export function mintRebookToken({ workspaceId, clientId, serviceId, ttlDays = REBOOK_TTL_DAYS, now = Date.now() }) {
  if (!workspaceId || !clientId || !serviceId) return null;
  const payload = { w: String(workspaceId), c: String(clientId), s: String(serviceId), e: Math.floor(now / 1000) + ttlDays * 86400 };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

// → { workspaceId, clientId, serviceId, expiresAt } or null (forged, malformed, expired).
export function verifyRebookToken(token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 600) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(given)) return null;
  const expected = Buffer.from(sign(body));
  const got = Buffer.from(given);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let p;
  try { p = JSON.parse(b64urlDecode(body).toString('utf8')); } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(p.w || '') || !UUID.test(p.c || '') || !UUID.test(p.s || '')) return null;
  if (!Number.isFinite(p.e) || p.e * 1000 <= now) return null;
  return { workspaceId: p.w, clientId: p.c, serviceId: p.s, expiresAt: new Date(p.e * 1000).toISOString() };
}

export function rebookUrl({ slug, token }) {
  if (!slug || !token) return null;
  return `${appUrl()}/book/${encodeURIComponent(slug)}?rebook=${encodeURIComponent(token)}`;
}

// ── date helpers (all on YYYY-MM-DD strings, no time zone surprises) ────
export function todayInZone(tz, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).reduce((a, p) => { if (p.type !== 'literal') a[p.type] = p.value; return a; }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
const isoOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const toUtc = (iso) => new Date(`${iso}T00:00:00Z`);
export const addDaysISO = (iso, n) => isoOf(new Date(toUtc(iso).getTime() + n * 86400000));
export const daysBetween = (a, b) => Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86400000);
export const weekdayOf = (iso) => toUtc(iso).getUTCDay();
export const weekdayName = (iso) => DAY_NAMES[weekdayOf(iso)];

export function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Median gap (days) → whole weeks within [1, 12].
export function weeksFromGapDays(days) {
  if (!Number.isFinite(days) || days <= 0) return null;
  return Math.max(REBOOK_MIN_WEEKS, Math.min(REBOOK_MAX_WEEKS, Math.round(days / 7)));
}

// Consecutive gaps between distinct sorted dates.
export function gapsOf(dates) {
  const uniq = [...new Set(dates.map(isoOf))].sort();
  const out = [];
  for (let i = 1; i < uniq.length; i++) out.push(daysBetween(uniq[i - 1], uniq[i]));
  return out;
}

// The client's own cadence for this service, or the service's typical one
// across the business, or the default. Pure: callers pass the dates.
//   clientDates: this client's past visit dates for the service
//   serviceGapsDays: gaps between consecutive visits for every client of the service
export function cadenceFrom({ clientDates = [], serviceGapsDays = [] }) {
  const own = gapsOf(clientDates);
  if (own.length >= 1) return { weeks: weeksFromGapDays(median(own)), usual: true, basis: 'client' };
  const w = weeksFromGapDays(median(serviceGapsDays));
  if (w) return { weeks: w, usual: false, basis: 'service' };
  return { weeks: REBOOK_DEFAULT_WEEKS, usual: false, basis: 'default' };
}

// The suggested day: anchor + weeks, moved forward a week at a time until it
// is after today, and back inside the booking horizon when one is set.
export function suggestedDate({ anchorISO, weeks, todayISO, maxAdvanceDays = 0 }) {
  let target = addDaysISO(anchorISO, weeks * 7);
  while (target <= todayISO) target = addDaysISO(target, 7);
  if (maxAdvanceDays > 0) {
    const horizon = addDaysISO(todayISO, maxAdvanceDays);
    while (target > horizon && addDaysISO(target, -7) > todayISO) target = addDaysISO(target, -7);
  }
  return target;
}

// Candidate start times on a day, nearest to `preferredStart` first.
export function candidateStarts({ windows, duration, step, preferredStart }) {
  const starts = [];
  for (const w of windows || []) {
    for (let t = w.start; t + duration <= w.end; t += step) starts.push(t);
  }
  const uniq = [...new Set(starts)];
  if (preferredStart == null) return uniq.sort((a, b) => a - b);
  return uniq.sort((a, b) => Math.abs(a - preferredStart) - Math.abs(b - preferredStart) || a - b);
}

// ── the suggestion ─────────────────────────────────────────────────────
// → { serviceId, serviceName, date, weekday, weekdayName, startMin, endMin,
//     weeks, usual, basis,
//     slot: 'same' | 'nearest' (same day) | 'later_week' (same weekday, a
//           later week) | 'other_day' (the next open day) | 'none' (the day alone) }
// or null when the service is gone or not bookable.
export async function computeRebookSuggestion({ workspaceId, clientId, serviceId, now = new Date() }) {
  const settings = await fetchCalendarSettings(workspaceId);
  if (!settings) return null;
  const svcRows = await sql`
    SELECT id, name, duration_minutes, capacity, availability, travel_buffer_minutes, visibility
      FROM services WHERE id = ${serviceId} AND workspace_id = ${workspaceId}`;
  const svc = svcRows.rows[0];
  if (!svc || svc.visibility === 'only_me') return null;
  const tz = settings.timezone || null;
  const todayISO = todayInZone(tz, now);

  const [mine, anyMine, svcAll] = await Promise.all([
    sql`SELECT date, start_min, end_min FROM bookings
         WHERE workspace_id = ${workspaceId} AND client_id = ${clientId} AND service_id = ${serviceId}
           AND cancelled_at IS NULL AND no_show_at IS NULL AND date <= ${todayISO}::date
           AND (requested_at IS NULL OR request_decided_at IS NOT NULL)
         ORDER BY date DESC, start_min DESC LIMIT 60`,
    sql`SELECT date, start_min, end_min FROM bookings
         WHERE workspace_id = ${workspaceId} AND client_id = ${clientId}
           AND cancelled_at IS NULL AND no_show_at IS NULL AND date <= ${todayISO}::date
           AND (requested_at IS NULL OR request_decided_at IS NOT NULL)
         ORDER BY date DESC, start_min DESC LIMIT 1`,
    sql`SELECT client_id, date FROM bookings
         WHERE workspace_id = ${workspaceId} AND service_id = ${serviceId} AND client_id IS NOT NULL
           AND cancelled_at IS NULL AND no_show_at IS NULL AND date <= ${todayISO}::date
           AND (requested_at IS NULL OR request_decided_at IS NOT NULL)
         ORDER BY client_id, date LIMIT 5000`,
  ]);
  const byClient = new Map();
  for (const r of svcAll.rows) {
    const k = String(r.client_id);
    if (!byClient.has(k)) byClient.set(k, []);
    byClient.get(k).push(isoOf(r.date));
  }
  const serviceGapsDays = [];
  for (const dates of byClient.values()) serviceGapsDays.push(...gapsOf(dates));
  const cadence = cadenceFrom({ clientDates: mine.rows.map((r) => r.date), serviceGapsDays });

  const anchor = mine.rows[0] || anyMine.rows[0] || null;
  const anchorISO = anchor ? isoOf(anchor.date) : todayISO;
  const maxAdvanceDays = Math.max(0, Number(settings.max_advance_days ?? 0));
  const target = suggestedDate({ anchorISO, weeks: cadence.weeks, todayISO, maxAdvanceDays });
  const horizonISO = maxAdvanceDays > 0 ? addDaysISO(todayISO, maxAdvanceDays) : addDaysISO(todayISO, 365);

  // Time: the same slot when free, else the nearest free one that day. When
  // the day has nothing free (fully booked, or the business no longer opens
  // on that weekday), the same weekday in the next weeks, then the next
  // open day after the target. Capped so a fully booked calendar stays cheap.
  const duration = Number(svc.duration_minutes) || 60;
  const step = Math.max(5, settings.slot_fit_service ? duration : (Number(settings.slot_minutes) || 30));
  const minNoticeMs = Math.max(0, Number(settings.min_notice_hours ?? 24)) * 3600 * 1000;
  const preferred = anchor && mine.rows[0] ? Number(anchor.start_min) : null;
  let checks = 0;
  const MAX_CHECKS = 60;
  const free = async (dateISO, start) => {
    checks++;
    if (slotEpochMs(dateISO, start, tz) < now.getTime() + minNoticeMs) return false;
    return !(await hasConflict({
      workspaceId, dateISO, start, end: start + duration, serviceId,
      capacity: Math.max(1, Number(svc.capacity) || 1),
      travelBufferMin: Number(svc.travel_buffer_minutes || 0), bufferMin: Number(settings.buffer_minutes || 0),
    }));
  };
  const firstFree = async (dateISO, perDay) => {
    const windows = effectiveWindows(settings.availability, svc.availability || null, weekdayOf(dateISO));
    const fits = (start) => windows.some((w) => start >= w.start && start + duration <= w.end);
    if (preferred != null && fits(preferred) && await free(dateISO, preferred)) return { start: preferred, same: true };
    const candidates = candidateStarts({ windows, duration, step, preferredStart: preferred })
      .filter((x) => x !== preferred).slice(0, perDay);
    for (const c of candidates) {
      if (checks >= MAX_CHECKS) return null;
      if (await free(dateISO, c)) return { start: c, same: false };
    }
    return null;
  };
  const days = [target, addDaysISO(target, 7), addDaysISO(target, 14), addDaysISO(target, 21)];
  for (let i = 1; i <= 13; i++) if (i % 7) days.push(addDaysISO(target, i));
  let date = target;
  let startMin = null;
  let slot = 'none';
  for (const [i, d] of days.entries()) {
    if (d > horizonISO || checks >= MAX_CHECKS) continue;
    const hit = await firstFree(d, i === 0 ? 30 : 12);
    if (hit) {
      date = d; startMin = hit.start;
      slot = hit.same && d === target ? 'same' : (d === target ? 'nearest' : (weekdayOf(d) === weekdayOf(target) ? 'later_week' : 'other_day'));
      break;
    }
  }
  const weekday = weekdayOf(date);
  return {
    serviceId: svc.id, serviceName: svc.name,
    date, weekday, weekdayName: DAY_NAMES[weekday],
    startMin, endMin: startMin == null ? null : startMin + duration,
    weeks: cadence.weeks, usual: cadence.usual, basis: cadence.basis, slot,
    // The client's usual weekday (their last visit's), for the "Your usual" line.
    usualWeekdayName: DAY_NAMES[weekdayOf(target)],
  };
}

// The client's most recent past service at this business (for "book again"
// when the caller has no service in mind). → { serviceId, bookingId } or null.
export async function lastServiceFor({ workspaceId, clientId }) {
  const { rows } = await sql`
    SELECT b.id, b.service_id FROM bookings b
      JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
     WHERE b.workspace_id = ${workspaceId} AND b.client_id = ${clientId}
       AND b.cancelled_at IS NULL AND b.no_show_at IS NULL AND b.service_id IS NOT NULL
       AND (b.requested_at IS NULL OR b.request_decided_at IS NOT NULL)
       AND s.visibility <> 'only_me'
     ORDER BY b.date DESC, b.start_min DESC LIMIT 1`;
  return rows[0] ? { serviceId: rows[0].service_id, bookingId: rows[0].id } : null;
}

// A link for a client + service (no suggestion yet: that is computed when
// the page opens, so it is always current). → { url, token } or null when
// the business has no booking page.
export async function mintRebookLink({ workspaceId, clientId, serviceId, slug = null }) {
  let s = slug;
  if (!s) {
    const cs = await fetchCalendarSettings(workspaceId);
    s = cs?.slug || null;
  }
  if (!s) return null;
  const token = mintRebookToken({ workspaceId, clientId, serviceId });
  if (!token) return null;
  return { url: rebookUrl({ slug: s, token }), token, slug: s };
}

// Plain words for the suggested day and time.
export function fmtSuggestionDay(sug) {
  if (!sug?.date) return '';
  const d = toUtc(sug.date);
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return sug.startMin == null ? day : `${day} at ${fmtMin(sug.startMin)}`;
}
export function fmtMin(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return '';
  const h = Math.floor(n / 60), mm = n % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}
// "Your usual: every 3 weeks on Fridays" - only from the client's own history.
export function usualLine(sug) {
  if (!sug?.usual) return null;
  return `Your usual: every ${sug.weeks === 1 ? 'week' : `${sug.weeks} weeks`} on ${sug.usualWeekdayName || sug.weekdayName}s`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const firstNameOf = (s) => String(s || '').trim().split(/\s+/)[0] || 'there';

// The owner's button and Ivy both go through here. Rate limited per client
// per day and per business per hour. Returns { allowed, retryAfterSeconds }.
// `scope` says which limit stopped it ('client' or 'business').
export async function rebookSendAllowed({ workspaceId, clientId }) {
  const a = await rateLimit({ key: `rebook:client:${clientId}`, max: REBOOK_SEND_PER_CLIENT_PER_DAY, windowSeconds: 86400 });
  if (!a.allowed) return { ...a, scope: 'client' };
  const b = await rateLimit({ key: `rebook:ws:${workspaceId}`, max: REBOOK_SEND_PER_WORKSPACE_PER_HOUR, windowSeconds: 3600 });
  return b.allowed ? b : { ...b, scope: 'business' };
}
// Plain words for a refusal from rebookSendAllowed.
export function rebookLimitMessage(gate, firstName = 'This client') {
  return gate?.scope === 'business'
    ? 'You have sent a lot of rebook links in the last hour. Try again in a little while.'
    : `${firstName} already got a rebook link today. Try again tomorrow.`;
}

// The rebook email (also the admin email preview, api/admin/email-preview.js).
// → { subject, html }
export function renderRebookEmail({ firstName, businessName, serviceName, usual, when, url, branding, footer = null }) {
  const subject = `Ready for your next ${serviceName}?`;
  const picked = when ? `We picked ${escapeHtml(when)} for you.` : '';
  return {
    subject,
    html: emailShell({
      heading: subject,
      body: `<p>Hi ${escapeHtml(firstName || 'there')},</p>
        <p>Booking your next <strong>${escapeHtml(serviceName)}</strong> with <strong>${escapeHtml(businessName)}</strong> takes one tap.</p>
        ${usual ? `<p><strong>${escapeHtml(usual)}.</strong> ${picked}</p>`
                : `<p>${picked} You can choose another time if that one does not suit.</p>`}`,
      ctaText: 'Book again', ctaUrl: url,
      footer: footer || `This link is just for you and works for ${REBOOK_TTL_DAYS} days.`,
      branding,
    }),
  };
}

// Email and (with consent and the choice) text a client their rebook link.
// Honours email opt-outs (type 'marketing' through sendEmailToClient), SMS
// consent and STOP, contact blocks, and quiet hours for texts. Never throws
// for a send that did not happen: the result says what went out and why not.
// → { ok, url, emailed, texted, emailReason, smsReason, suggestion, client, service }
export async function sendRebookLink({ workspaceId, clientId, serviceId = null, bookingId = null, channels = { email: true, sms: true } }) {
  const c = await sql`
    SELECT id, name, email, phone, sms_consent_at, sms_stopped_at FROM clients
     WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
  const client = c.rows[0];
  if (!client) return { ok: false, error: 'Client not found' };
  const blocked = await sql`SELECT 1 FROM contact_blocks WHERE workspace_id = ${workspaceId} AND client_id = ${clientId} LIMIT 1`;
  if (blocked.rows.length) return { ok: false, error: 'Messages between you and this client are blocked' };
  let svcId = serviceId;
  // The visit the send is recorded on (rebook_link_sent_at): the caller's,
  // else the client's latest (Ivy sends without one), so "a rebook link in
  // the last 7 days" covers every way a link goes out.
  let recordOn = bookingId;
  if (!svcId || !recordOn) {
    const last = await lastServiceFor({ workspaceId, clientId });
    if (!svcId) svcId = last?.serviceId || null;
    if (!recordOn) recordOn = last?.bookingId || null;
  }
  if (!svcId) return { ok: false, error: `${firstNameOf(client.name)} has no past appointment to book again` };
  const link = await mintRebookLink({ workspaceId, clientId, serviceId: svcId });
  if (!link) return { ok: false, error: 'This business has no booking page yet. Choose a booking address in Calendar first' };
  const sug = await computeRebookSuggestion({ workspaceId, clientId, serviceId: svcId });
  if (!sug) return { ok: false, error: 'That service is not available to book' };
  const branding = await fetchBranding(workspaceId).catch(() => ({}));
  const business = branding.businessName || 'us';
  const first = firstNameOf(client.name);
  const usual = usualLine(sug);
  const when = fmtSuggestionDay(sug);

  // *Code: the plain reason for callers that decide what to retry (the
  // automation); *Reason: the words shown to the owner.
  let emailed = false, emailReason = null, emailCode = null;
  if (channels.email !== false) {
    if (!client.email) { emailReason = 'no email on file'; emailCode = 'no email'; }
    else {
      const mail = renderRebookEmail({ firstName: first, businessName: business, serviceName: sug.serviceName, usual, when, url: link.url, branding });
      const r = await sendEmailToClient({
        clientId: client.id, workspaceId, type: 'marketing', to: client.email,
        subject: mail.subject, replyTo: branding.replyTo, html: mail.html,
      }).catch((e) => ({ ok: false, sent: false, reason: e?.message || 'send failed' }));
      emailed = !!r?.sent;
      if (!emailed) {
        emailCode = r?.reason || 'send failed';
        emailReason = r?.reason === 'muted' ? 'the client turned off these emails' : (r?.reason || 'the email did not go out');
      }
    }
  } else { emailReason = 'not chosen'; emailCode = 'not chosen'; }

  let texted = false, smsReason = null, smsCode = null;
  if (channels.sms !== false) {
    if (!client.phone) { smsReason = 'no phone on file'; smsCode = 'no phone'; }
    else if (!client.sms_consent_at || client.sms_stopped_at) { smsReason = 'the client has not agreed to texts'; smsCode = 'no consent'; }
    else {
      const r = await sendClientSms({
        workspaceId, phone: client.phone, consentAt: client.sms_consent_at, respectQuietHours: true,
        body: `Hi ${first}, ready for your next ${sug.serviceName} with ${business}? Book again here: ${link.url}`,
      });
      texted = !!r.ok;
      if (!texted) {
        smsCode = r.reason || 'send failed';
        smsReason = r.reason === 'quiet-hours' ? 'it is outside texting hours' : (r.reason || 'the text did not go out');
      }
    }
  } else { smsReason = 'not chosen'; smsCode = 'not chosen'; }

  if (recordOn && (emailed || texted)) {
    await sql`UPDATE bookings SET rebook_link_sent_at = NOW() WHERE id = ${recordOn} AND workspace_id = ${workspaceId}`.catch(() => {});
  }
  return {
    ok: emailed || texted, url: link.url, emailed, texted, emailReason, smsReason, emailCode, smsCode, suggestion: sug,
    client: { id: client.id, name: client.name, email: client.email || null, phone: client.phone || null },
    service: { id: sug.serviceId, name: sug.serviceName },
  };
}
