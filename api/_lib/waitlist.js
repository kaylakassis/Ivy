// The booking waitlist (waitlist_entries + waitlist_offers), 1.0.6.
//
//   • Joining: the public booking page (and the shop flow) call joinWaitlist
//     when a day is full. An entry is either for one exact slot (the first
//     one that could open up that day) or FLEXIBLE: preferred weekdays and a
//     time window. Caps: 3 open entries per client per service, 200 open per
//     workspace; entries expire after 60 days.
//   • Filling: when a confirmed booking is cancelled (owner, client, Ivy,
//     no-show cancel) the cancel paths call fillFromWaitlistOnCancel. With
//     the owner's "fill automatically" switch on, the best match is OFFERED
//     the spot: one email and (with consent) one text with a signed one-tap
//     claim link. The link expires (owner setting, default 2 hours); the
//     cron (api/cron/booking-requests.js) then offers the next person. First
//     to tap gets it: claiming is an atomic status flip on the offer, and the
//     booking itself goes through the normal public booking path (deposit,
//     policy, confirmation).
//   • The owner can also offer a time by hand from the Waitlist drawer.
//
// Every query is scoped by workspace_id. Nothing here throws on a notify
// failure: an email problem never undoes a claim or a cancel.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { sendEmailToClient, sendEmailToClientByAddress, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { sendClientSms } from './sms.js';
import { appUrl, generateRawToken } from './tokens.js';
import { hasConflict, fetchCalendarSettings, slotEpochMs } from './calendar.js';
import { notifyOwnerSafe } from './push.js';
import { keepAlive } from './keepAlive.js';

export const WAITLIST_MAX_PER_CLIENT_PER_SERVICE = 3;
export const WAITLIST_MAX_OPEN_PER_WORKSPACE = 200;
export const WAITLIST_ENTRY_DAYS = 60;
export const OFFER_HOURS_OPTIONS = [1, 2, 4, 12, 24];
export const DEFAULT_OFFER_HOURS = 2;
export const OPEN_STATUSES = ['waiting', 'offered'];

// The owner's waitlist switches, from a calendar_settings row.
export function waitlistSettings(row) {
  const hours = Number(row?.waitlist_offer_hours);
  return {
    enabled: row ? row.waitlist_enabled !== false : true,
    autoFill: row ? row.waitlist_auto_fill !== false : true,
    offerHours: OFFER_HOURS_OPTIONS.includes(hours) ? hours : DEFAULT_OFFER_HOURS,
  };
}

const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const first = (name) => (String(name || '').trim().split(/\s+/)[0] || 'there');
function fmtTime(min) {
  const h = Math.floor(Number(min) / 60), m = Number(min) % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}
function fmtDay(iso) {
  const d = new Date(`${isoDate(iso)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate(iso);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function fmtStamp(ts, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
  } catch { return new Date(ts).toISOString(); }
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function serializeWaitlistEntry(row) {
  if (!row) return null;
  return {
    id:            row.id,
    serviceId:     row.service_id,
    clientId:      row.client_id,
    clientName:    row.client_name,
    clientEmail:   row.client_email,
    clientPhone:   row.client_phone,
    date:          isoDate(row.date),
    startMin:      row.start_min,
    endMin:        row.end_min,
    notes:         row.notes || null,
    status:        row.status,
    promotedBookingId: row.promoted_booking_id,
    promotedAt:    row.promoted_at,
    createdAt:     row.created_at,
    // 1.0.6
    flexible:      !!row.flexible,
    preferredDays: Array.isArray(row.preferred_days) ? row.preferred_days : [],
    preferredStartMin: row.preferred_start_min ?? null,
    preferredEndMin:   row.preferred_end_min ?? null,
    smsConsent:    !!row.sms_consent_at,
    expiresAt:     row.expires_at || null,
    preferenceLabel: describePreference(row),
  };
}

// "Tue, Thu mornings" / "Any day, 2:00 pm to 6:00 pm" / "Mar 3 at 10:00 am"
export function describePreference(row) {
  if (!row) return '';
  if (!row.flexible) return `${fmtDay(row.date)} at ${fmtTime(row.start_min)}`;
  const days = Array.isArray(row.preferred_days) && row.preferred_days.length
    ? row.preferred_days.slice().sort().map((d) => DAY_NAMES[d] || '').filter(Boolean).join(', ')
    : 'Any day';
  const window = row.preferred_start_min != null || row.preferred_end_min != null
    ? `${fmtTime(row.preferred_start_min ?? 0)} to ${fmtTime(row.preferred_end_min ?? 24 * 60)}`
    : 'any time';
  return `${days}, ${window}`;
}

// ── joining ─────────────────────────────────────────────────────────────

function cleanDays(v) {
  if (!Array.isArray(v)) return [];
  const out = [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))];
  return out.sort();
}
function cleanMinute(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 24 * 60 ? n : NaN;
}

// Returns { entry, alreadyJoined } or { error, status }.
export async function joinWaitlist({
  workspaceId, serviceId, clientName, clientEmail, clientPhone = null, smsConsent = false,
  date, startMin, endMin, notes = null,
  flexible = false, preferredDays = [], preferredStartMin = null, preferredEndMin = null,
}) {
  const email = String(clientEmail || '').trim().toLowerCase();
  const name = String(clientName || '').trim().slice(0, 120);
  if (!workspaceId || !serviceId || !email || !name) return { error: 'Your name and email are required', status: 400 };
  const days = cleanDays(preferredDays);
  const ps = cleanMinute(preferredStartMin);
  const pe = cleanMinute(preferredEndMin);
  if (Number.isNaN(ps) || Number.isNaN(pe)) return { error: 'Preferred times are not valid', status: 400 };
  if (ps != null && pe != null && pe <= ps) return { error: 'Preferred end time must be after the start', status: 400 };
  const isFlexible = !!flexible;

  // Same person, same service, same exact slot (or already flexible for
  // this service): no second entry.
  const dup = isFlexible
    ? await sql`
        SELECT id FROM waitlist_entries
         WHERE workspace_id = ${workspaceId} AND service_id = ${serviceId}
           AND LOWER(client_email) = ${email} AND flexible = TRUE
           AND status = ANY(${OPEN_STATUSES}) LIMIT 1`
    : await sql`
        SELECT id FROM waitlist_entries
         WHERE workspace_id = ${workspaceId} AND service_id = ${serviceId}
           AND date = ${date} AND start_min = ${startMin} AND end_min = ${endMin}
           AND LOWER(client_email) = ${email} AND status = ANY(${OPEN_STATUSES}) LIMIT 1`;
  if (dup.rows.length > 0) {
    const e = await sql`SELECT * FROM waitlist_entries WHERE id = ${dup.rows[0].id}`;
    return { entry: e.rows[0], alreadyJoined: true };
  }
  const caps = await sql`
    SELECT
      COUNT(*) FILTER (WHERE service_id = ${serviceId} AND LOWER(client_email) = ${email})::int AS mine,
      COUNT(*)::int AS total
      FROM waitlist_entries
     WHERE workspace_id = ${workspaceId} AND status = ANY(${OPEN_STATUSES}) AND expires_at > NOW()`;
  if ((caps.rows[0]?.mine || 0) >= WAITLIST_MAX_PER_CLIENT_PER_SERVICE) {
    return { error: "You're already on the waitlist for this service. We'll reach out as soon as a spot opens.", status: 409 };
  }
  if ((caps.rows[0]?.total || 0) >= WAITLIST_MAX_OPEN_PER_WORKSPACE) {
    return { error: 'The waitlist is full right now. Please check back soon or pick another time.', status: 409 };
  }
  const existing = await sql`
    SELECT id FROM clients WHERE workspace_id = ${workspaceId} AND LOWER(email) = ${email} LIMIT 1`;
  const clientId = existing.rows[0]?.id || null;
  const consentAt = smsConsent && clientPhone ? new Date().toISOString() : null;
  const ins = await sql`
    INSERT INTO waitlist_entries (
      workspace_id, service_id, client_id, client_name, client_email, client_phone,
      date, start_min, end_min, notes, flexible, preferred_days, preferred_start_min, preferred_end_min,
      sms_consent_at, expires_at
    ) VALUES (
      ${workspaceId}, ${serviceId}, ${clientId}, ${name}, ${email}, ${clientPhone || null},
      ${date}, ${startMin}, ${endMin}, ${notes ? String(notes).slice(0, 1000) : null},
      ${isFlexible}, ${days}::int[], ${ps}, ${pe},
      ${consentAt}, NOW() + make_interval(days => ${WAITLIST_ENTRY_DAYS})
    )
    RETURNING *`;
  return { entry: ins.rows[0], alreadyJoined: false };
}

// ── matching + offering ─────────────────────────────────────────────────

// Open entries that fit this slot, best first: exact-slot entries, then
// flexible ones whose preferred days and window cover it, each oldest
// first. Never an entry already holding an offer.
export async function candidatesForSlot({ workspaceId, serviceId, dateISO, startMin, endMin, excludeEntryIds = [] }) {
  const date = isoDate(dateISO);
  const { rows } = await sql.query(
    `SELECT * FROM waitlist_entries w
      WHERE w.workspace_id = $1 AND w.service_id = $2
        AND w.status = 'waiting' AND w.expires_at > NOW()
        AND NOT (w.id = ANY($6::uuid[]))
        AND (
          (w.flexible = FALSE AND w.date = $3::date AND w.start_min = $4 AND w.end_min = $5)
          OR (w.flexible = TRUE
              AND (cardinality(w.preferred_days) = 0 OR EXTRACT(DOW FROM $3::date)::int = ANY(w.preferred_days))
              AND (w.preferred_start_min IS NULL OR $4 >= w.preferred_start_min)
              AND (w.preferred_end_min IS NULL OR $4 < w.preferred_end_min))
        )
      ORDER BY w.flexible ASC, w.created_at ASC
      LIMIT 20`,
    [workspaceId, serviceId, date, startMin, endMin, excludeEntryIds],
  );
  return rows;
}

// Still bookable by a waitlister: not in the past, not taken again.
async function slotIsFree({ workspaceId, serviceId, dateISO, startMin, endMin, settingsRow = null }) {
  const date = isoDate(dateISO);
  const settings = settingsRow || await fetchCalendarSettings(workspaceId);
  const startMs = slotEpochMs(date, startMin, settings?.timezone || null);
  if (Number.isFinite(startMs) && startMs < Date.now() + 15 * 60_000) return false;
  const svc = await sql`
    SELECT capacity, travel_buffer_minutes FROM services WHERE id = ${serviceId} AND workspace_id = ${workspaceId}`;
  if (!svc.rows[0]) return false;
  const taken = await hasConflict({
    workspaceId, dateISO: date, start: startMin, end: endMin, serviceId,
    capacity: Math.max(1, Number(svc.rows[0].capacity) || 1),
    travelBufferMin: Math.max(0, Number(svc.rows[0].travel_buffer_minutes || 0)),
    bufferMin: Math.max(0, Number(settings?.buffer_minutes || 0)),
  });
  return !taken;
}

export function claimUrl({ slug, rawToken }) {
  return `${appUrl()}/book/${encodeURIComponent(slug || '')}?claim=${encodeURIComponent(rawToken)}`;
}

// Offer one slot to one entry. Marks the entry 'offered', stores the hashed
// token, sends the email and (with consent) the text. Returns { offer, rawToken }.
export async function createOffer({ workspaceId, entry, dateISO, startMin, endMin, sourceBookingId = null, offeredBy = 'auto', offerHours = null }) {
  const settings = await fetchCalendarSettings(workspaceId);
  const hours = OFFER_HOURS_OPTIONS.includes(Number(offerHours)) ? Number(offerHours) : waitlistSettings(settings).offerHours;
  const rawToken = generateRawToken(24);
  const date = isoDate(dateISO);
  const ins = await sql`
    INSERT INTO waitlist_offers (workspace_id, entry_id, service_id, date, start_min, end_min, token_hash,
                                 source_booking_id, offered_by, expires_at)
    VALUES (${workspaceId}, ${entry.id}, ${entry.service_id}, ${date}, ${startMin}, ${endMin}, ${hashToken(rawToken)},
            ${sourceBookingId}, ${offeredBy}, NOW() + make_interval(hours => ${hours}))
    RETURNING *`;
  const offer = ins.rows[0];
  await sql`UPDATE waitlist_entries SET status = 'offered', updated_at = NOW() WHERE id = ${entry.id} AND workspace_id = ${workspaceId}`;
  keepAlive(notifyOffer({ workspaceId, entry, offer, rawToken, settings })
    .catch((e) => console.error('[waitlist] offer notify failed:', e?.message)));
  return { offer, rawToken };
}

async function smsConsentFor({ workspaceId, entry }) {
  if (!entry.client_phone) return null;
  const digits = (String(entry.client_phone).match(/\d/g) || []).join('').slice(-10);
  // A STOP from this number at this business always wins.
  const c = await sql`
    SELECT MAX(sms_consent_at) AS consent, BOOL_OR(sms_stopped_at IS NOT NULL) AS stopped
      FROM clients
     WHERE workspace_id = ${workspaceId}
       AND right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = ${digits}`;
  if (c.rows[0]?.stopped) return null;
  return entry.sms_consent_at || c.rows[0]?.consent || null;
}

async function notifyOffer({ workspaceId, entry, offer, rawToken, settings }) {
  const s = settings || await fetchCalendarSettings(workspaceId);
  const svc = await sql`SELECT name FROM services WHERE id = ${entry.service_id} AND workspace_id = ${workspaceId}`;
  const biz = s?.biz_name || 'The business';
  const service = svc.rows[0]?.name || 'Session';
  const day = fmtDay(offer.date);
  const time = fmtTime(offer.start_min);
  const link = claimUrl({ slug: s?.slug, rawToken });
  const until = fmtStamp(offer.expires_at, s?.timezone);
  const line = `A spot opened: ${service}, ${day} at ${time}.`;
  if (entry.client_email) {
    const branding = await fetchBranding(workspaceId).catch(() => null);
    const html = emailShell({
      heading: 'A spot opened up',
      branding,
      body: `<p>Hi ${escapeHtml(first(entry.client_name))},</p>
        <p>${escapeHtml(line)} Tap to book: <a href="${escapeHtml(link)}" style="color:#2E3168;">${escapeHtml(link)}</a></p>
        <p><strong>First to tap gets it.</strong> This link works until ${escapeHtml(until)}; after that the spot goes to the next person on the list.</p>`,
      ctaText: 'Book this spot',
      ctaUrl: link,
      footer: `You asked ${escapeHtml(biz)} to let you know when a spot opened. If this no longer works for you, just ignore this email.`,
    });
    const args = { workspaceId, type: 'bookings', subject: `A spot opened: ${service}, ${day} at ${time}`, html, replyTo: branding?.replyTo };
    if (entry.client_id) await sendEmailToClient({ clientId: entry.client_id, to: entry.client_email, ...args });
    else await sendEmailToClientByAddress({ email: entry.client_email, ...args });
  }
  const consentAt = await smsConsentFor({ workspaceId, entry });
  if (consentAt) {
    await sendClientSms({
      phone: entry.client_phone, consentAt, workspaceId,
      body: `${biz}: ${line} Tap to book: ${link} First to tap gets it.`,
    }).catch(() => {});
  }
}

// A confirmed booking was cancelled: offer the freed time to the best
// match, when the owner has the waitlist and automatic filling on.
// Returns the offer row or null. Best-effort for every caller.
export async function fillFromWaitlistOnCancel({ workspaceId, serviceId, dateISO, startMin, endMin, sourceBookingId = null }) {
  if (!workspaceId || !serviceId) return null;
  const settings = await fetchCalendarSettings(workspaceId);
  const ws = waitlistSettings(settings);
  if (!ws.enabled || !ws.autoFill) return null;
  return offerNextForSlot({ workspaceId, serviceId, dateISO, startMin, endMin, sourceBookingId, settingsRow: settings });
}

// Offer the slot to the next matching entry (nobody else may already hold
// an open offer for it, and it must still be free). Shared by the cancel
// paths and the cron's "next person" step.
export async function offerNextForSlot({ workspaceId, serviceId, dateISO, startMin, endMin, sourceBookingId = null, excludeEntryIds = [], settingsRow = null, offeredBy = 'auto' }) {
  const date = isoDate(dateISO);
  const open = await sql`
    SELECT 1 FROM waitlist_offers
     WHERE workspace_id = ${workspaceId} AND service_id = ${serviceId}
       AND date = ${date} AND start_min = ${startMin} AND end_min = ${endMin}
       AND status IN ('open', 'claiming') AND expires_at > NOW()
     LIMIT 1`;
  if (open.rows.length > 0) return null;
  const candidates = await candidatesForSlot({ workspaceId, serviceId, dateISO: date, startMin, endMin, excludeEntryIds });
  if (candidates.length === 0) return null;
  if (!(await slotIsFree({ workspaceId, serviceId, dateISO: date, startMin, endMin, settingsRow }))) return null;
  const { offer } = await createOffer({
    workspaceId, entry: candidates[0], dateISO: date, startMin, endMin, sourceBookingId, offeredBy,
  });
  return offer;
}

// Backwards-compatible name for the older cancel paths. The waitlist no
// longer books anyone without their tap, so this never returns a booking.
export async function promoteWaitlistOnCancel(args) {
  await fillFromWaitlistOnCancel(args).catch((e) => console.error('[waitlist] fill failed:', e.message));
  return null;
}

// ── claiming ────────────────────────────────────────────────────────────

// The offer behind a claim link, with what the booking page needs to show
// it. `state` is 'open' | 'expired' | 'claimed' | 'gone'. Null = no such token.
export async function loadOfferByToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length > 200) return null;
  const { rows } = await sql`
    SELECT o.*, w.client_name, w.client_email, w.client_phone, w.client_id, w.notes AS entry_notes, w.status AS entry_status,
           s.name AS service_name, s.duration_minutes,
           cs.slug, cs.biz_name, cs.timezone
      FROM waitlist_offers o
      JOIN waitlist_entries w ON w.id = o.entry_id AND w.workspace_id = o.workspace_id
      LEFT JOIN services s ON s.id = o.service_id AND s.workspace_id = o.workspace_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = o.workspace_id
     WHERE o.token_hash = ${hashToken(rawToken)}
     LIMIT 1`;
  const o = rows[0];
  if (!o) return null;
  let state = 'open';
  if (o.status === 'claimed') state = 'claimed';
  else if (o.status === 'open' || o.status === 'claiming') state = new Date(o.expires_at).getTime() > Date.now() ? 'open' : 'expired';
  else if (o.status === 'expired') state = 'expired';
  else state = 'gone';
  return { ...o, state };
}

export function serializeOfferForClient(o) {
  if (!o) return null;
  return {
    id: o.id, state: o.state,
    serviceId: o.service_id, serviceName: o.service_name || 'Session',
    date: isoDate(o.date), startMin: o.start_min, endMin: o.end_min,
    expiresAt: o.expires_at,
    clientName: o.client_name, clientEmail: o.client_email, clientPhone: o.client_phone || null,
    businessName: o.biz_name || null, slug: o.slug || null,
  };
}

// First to tap gets it: only one caller ever moves the offer from 'open' to
// 'claiming'. Returns true for the winner.
export async function claimOffer({ offerId, workspaceId }) {
  const r = await sql`
    UPDATE waitlist_offers SET status = 'claiming'
     WHERE id = ${offerId} AND workspace_id = ${workspaceId} AND status = 'open' AND expires_at > NOW()
     RETURNING id`;
  return r.rows.length > 0;
}

// The claim's booking did not go through: the offer is open again.
export async function releaseOffer({ offerId, workspaceId }) {
  await sql`UPDATE waitlist_offers SET status = 'open' WHERE id = ${offerId} AND workspace_id = ${workspaceId} AND status = 'claiming'`;
}

// The slot was taken by someone else before the claim: the offer is over
// and the entry stays on the list for the next opening.
export async function offerSlotGone({ offerId, workspaceId }) {
  const r = await sql`
    UPDATE waitlist_offers SET status = 'slot_gone'
     WHERE id = ${offerId} AND workspace_id = ${workspaceId} AND status IN ('open', 'claiming')
     RETURNING entry_id`;
  if (r.rows[0]) {
    await sql`UPDATE waitlist_entries SET status = 'waiting', updated_at = NOW() WHERE id = ${r.rows[0].entry_id} AND workspace_id = ${workspaceId} AND status = 'offered'`;
  }
}

// The claim booked: the entry is fulfilled and the owner hears about it.
export async function completeOffer({ offerId, workspaceId, bookingId }) {
  const r = await sql`
    UPDATE waitlist_offers SET status = 'claimed', claimed_at = NOW(), claimed_booking_id = ${bookingId}
     WHERE id = ${offerId} AND workspace_id = ${workspaceId} AND status IN ('claiming', 'open')
     RETURNING *`;
  const offer = r.rows[0];
  if (!offer) return null;
  await sql`
    UPDATE waitlist_entries SET status = 'fulfilled', promoted_at = NOW(), promoted_booking_id = ${bookingId}, updated_at = NOW()
     WHERE id = ${offer.entry_id} AND workspace_id = ${workspaceId}`;
  keepAlive((async () => {
    const b = await sql`
      SELECT b.client_name, b.date, b.start_min, s.name AS service_name
        FROM bookings b LEFT JOIN services s ON s.id = b.service_id AND s.workspace_id = b.workspace_id
       WHERE b.id = ${bookingId} AND b.workspace_id = ${workspaceId}`;
    const row = b.rows[0];
    if (!row) return;
    notifyOwnerSafe({
      workspaceId, type: 'bookings',
      payload: {
        title: 'Spot filled from your waitlist',
        body: `${first(row.client_name)} took ${row.service_name || 'the session'} on ${fmtDay(row.date)} at ${fmtTime(row.start_min)}.`,
        url: `/calendar?booking=${bookingId}`, tag: `waitlist-claimed-${bookingId}`,
      },
    });
  })().catch((e) => console.error('[waitlist] claimed push failed:', e?.message)));
  return offer;
}

// ── cron sweeps ─────────────────────────────────────────────────────────

// Offers whose link ran out: close them, put the entry back on the list,
// and offer the same spot to the next person while it is still free.
export async function sweepWaitlistOffers({ limit = 200 } = {}) {
  const { rows } = await sql`
    SELECT * FROM waitlist_offers
     WHERE status IN ('open', 'claiming') AND expires_at < NOW()
     ORDER BY expires_at ASC
     LIMIT ${Math.max(1, Math.min(1000, limit))}`;
  let expired = 0, reoffered = 0;
  for (const o of rows) {
    // eslint-disable-next-line no-await-in-loop
    const flip = await sql`
      UPDATE waitlist_offers SET status = 'expired'
       WHERE id = ${o.id} AND status IN ('open', 'claiming') AND expires_at < NOW()
       RETURNING id`;
    if (flip.rows.length === 0) continue;
    expired += 1;
    // eslint-disable-next-line no-await-in-loop
    await sql`UPDATE waitlist_entries SET status = 'waiting', updated_at = NOW()
               WHERE id = ${o.entry_id} AND workspace_id = ${o.workspace_id} AND status = 'offered'`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const settings = await fetchCalendarSettings(o.workspace_id);
      if (!waitlistSettings(settings).enabled) continue;
      // eslint-disable-next-line no-await-in-loop
      const next = await offerNextForSlot({
        workspaceId: o.workspace_id, serviceId: o.service_id, dateISO: o.date, startMin: o.start_min, endMin: o.end_min,
        sourceBookingId: o.source_booking_id, excludeEntryIds: [o.entry_id], settingsRow: settings,
      });
      if (next) reoffered += 1;
    } catch (err) {
      console.error('[waitlist] re-offer failed:', err.message);
    }
  }
  return { expired, reoffered };
}

// Entries older than 60 days leave the list quietly.
export async function expireWaitlistEntries() {
  const r = await sql`
    UPDATE waitlist_entries SET status = 'expired', updated_at = NOW()
     WHERE status = 'waiting' AND expires_at < NOW()`;
  return r.rowCount || 0;
}

// ── owner actions ───────────────────────────────────────────────────────

export async function removeWaitlistEntry({ workspaceId, id }) {
  const r = await sql`
    UPDATE waitlist_entries SET status = 'cancelled', updated_at = NOW()
     WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = ANY(${OPEN_STATUSES})
     RETURNING id`;
  if (r.rows.length === 0) return { notFound: true };
  await sql`UPDATE waitlist_offers SET status = 'withdrawn' WHERE entry_id = ${id} AND workspace_id = ${workspaceId} AND status IN ('open', 'claiming')`;
  return { ok: true };
}

// "Offer a time" from the Waitlist drawer or Ivy. The time must be free and
// the entry open. Returns { offer } or { error }.
export async function offerTimeToEntry({ workspaceId, entryId, dateISO, startMin, endMin, offeredBy = 'owner' }) {
  const e = await sql`SELECT * FROM waitlist_entries WHERE id = ${entryId} AND workspace_id = ${workspaceId}`;
  const entry = e.rows[0];
  if (!entry) return { error: 'Waitlist entry not found', status: 404 };
  if (!OPEN_STATUSES.includes(entry.status)) return { error: 'This person is no longer waiting', status: 400 };
  const date = isoDate(dateISO);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'date must be YYYY-MM-DD', status: 400 };
  const start = Number(startMin), end = Number(endMin);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > 24 * 60) {
    return { error: 'That time is not valid', status: 400 };
  }
  const svc = await sql`SELECT duration_minutes FROM services WHERE id = ${entry.service_id} AND workspace_id = ${workspaceId}`;
  if (!svc.rows[0]) return { error: 'That service no longer exists', status: 400 };
  if (end - start !== Number(svc.rows[0].duration_minutes)) return { error: 'The time must match the length of the service', status: 400 };
  if (!(await slotIsFree({ workspaceId, serviceId: entry.service_id, dateISO: date, startMin: start, endMin: end }))) {
    return { error: 'That time is taken or has passed', status: 409 };
  }
  // One open offer per entry at a time.
  await sql`UPDATE waitlist_offers SET status = 'withdrawn' WHERE entry_id = ${entryId} AND workspace_id = ${workspaceId} AND status IN ('open', 'claiming')`;
  const { offer } = await createOffer({ workspaceId, entry, dateISO: date, startMin: start, endMin: end, offeredBy });
  return { offer, entry };
}

export function serializeOffer(o) {
  if (!o) return null;
  return {
    id: o.id, entryId: o.entry_id, serviceId: o.service_id,
    date: isoDate(o.date), startMin: o.start_min, endMin: o.end_min,
    status: o.status, offeredBy: o.offered_by, expiresAt: o.expires_at, claimedAt: o.claimed_at || null,
    claimedBookingId: o.claimed_booking_id || null, createdAt: o.created_at,
  };
}

// Open entries with their service name and latest offer, oldest first.
export async function listWaitlist(workspaceId, { includeClosed = false, limit = 500 } = {}) {
  const { rows } = await sql.query(
    `SELECT w.*, s.name AS service_name,
            (SELECT row_to_json(o) FROM (
               SELECT o.id, o.date, o.start_min, o.end_min, o.status, o.expires_at, o.offered_by, o.claimed_at, o.created_at
                 FROM waitlist_offers o WHERE o.entry_id = w.id AND o.workspace_id = w.workspace_id
                ORDER BY o.created_at DESC LIMIT 1) o) AS last_offer
       FROM waitlist_entries w
       LEFT JOIN services s ON s.id = w.service_id AND s.workspace_id = w.workspace_id
      WHERE w.workspace_id = $1
        AND ($2::boolean OR w.status IN ('waiting', 'offered'))
      ORDER BY CASE w.status WHEN 'offered' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, w.created_at ASC
      LIMIT $3`,
    [workspaceId, includeClosed, Math.max(1, Math.min(1000, limit))],
  );
  return rows.map((r) => ({
    ...serializeWaitlistEntry(r),
    serviceName: r.service_name || 'Service',
    lastOffer: r.last_offer ? {
      id: r.last_offer.id, date: isoDate(r.last_offer.date), startMin: r.last_offer.start_min, endMin: r.last_offer.end_min,
      status: r.last_offer.status, expiresAt: r.last_offer.expires_at, offeredBy: r.last_offer.offered_by,
      claimedAt: r.last_offer.claimed_at || null, createdAt: r.last_offer.created_at,
    } : null,
  }));
}

// People waiting, by service (for the dashboard and Ivy).
export async function waitlistSummary(workspaceId) {
  const { rows } = await sql`
    SELECT w.service_id, s.name AS service_name, COUNT(*)::int AS waiting
      FROM waitlist_entries w
      LEFT JOIN services s ON s.id = w.service_id AND s.workspace_id = w.workspace_id
     WHERE w.workspace_id = ${workspaceId} AND w.status = ANY(${OPEN_STATUSES}) AND w.expires_at > NOW()
     GROUP BY w.service_id, s.name
     ORDER BY waiting DESC, s.name ASC`;
  return rows.map((r) => ({ serviceId: r.service_id, serviceName: r.service_name || 'Service', waiting: r.waiting }));
}

export { fmtDay as waitlistDay, fmtTime as waitlistTime };
