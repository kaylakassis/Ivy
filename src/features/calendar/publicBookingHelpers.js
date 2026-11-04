// Pure helpers for the public booking page (/book/:slug and /embed/book/:slug).
// No React, no DOM: everything here is unit tested from node
// (tests/public-booking-helpers.test.mjs).
import { addDays, fmtDateISO, minToHM, slotsForDate, slugify } from './utils.js';
import { zonedTimeToUtcMs, isValidTimeZone } from '../../lib/tz.js';

// ── Time grouping ───────────────────────────────────────────────────────
// Morning: before noon. Afternoon: noon to 5 pm. Evening: 5 pm on.
export const PERIODS = [
  { key: 'morning',   label: 'Morning',   from: 0,       to: 12 * 60 },
  { key: 'afternoon', label: 'Afternoon', from: 12 * 60, to: 17 * 60 },
  { key: 'evening',   label: 'Evening',   from: 17 * 60, to: 24 * 60 + 1 },
];

// [{ key, label, slots }] in day order, empty periods left out. Every slot
// is kept (no "+N more"); input order does not matter.
export function groupSlotsByPeriod(slots) {
  const sorted = (Array.isArray(slots) ? slots : [])
    .filter((s) => s && Number.isFinite(Number(s.start)))
    .slice()
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const p of PERIODS) {
    const inP = sorted.filter((s) => s.start >= p.from && s.start < p.to);
    if (inP.length) out.push({ key: p.key, label: p.label, slots: inP });
  }
  return out;
}

// Reasons slotsForDate gives a slot that can never be booked from this page,
// whatever happens to other bookings. Anything else (Booked, Blocked, a full
// class) could still open up, so it is waitlist material.
const UNBOOKABLE = new Set(['Past', 'Too soon', 'Too far']);

// One day's status from its full slot list (slotsForDate output):
//   'open'   at least one bookable time
//   'full'   times are taken by bookings (the waitlist path)
//   'none'   times exist but are past / too soon / beyond the horizon
//   'closed' not open that day for this service, or the owner blocked it off
//            (time off is not something to wait-list for)
export function dayStatus(allSlots) {
  const list = Array.isArray(allSlots) ? allSlots : [];
  if (list.length === 0) return 'closed';
  if (list.some((s) => s.available)) return 'open';
  if (list.some(isWaitlistable)) return 'full';
  if (list.some((s) => s.reason === 'Blocked')) return 'closed';
  return 'none';
}

// Taken by a booking (or a full class): could open up again.
function isWaitlistable(s) {
  return !s.available && !UNBOOKABLE.has(s.reason) && s.reason !== 'Blocked';
}

// The slot a waitlist entry should point at on a full day: the first one
// that could actually open up (never a past, too-soon or blocked one).
export function waitlistSeed(allSlots) {
  const list = Array.isArray(allSlots) ? allSlots : [];
  return list.find(isWaitlistable) || null;
}

// ── Days for the date strip ─────────────────────────────────────────────
// How many days the strip may ever show: the owner's booking horizon
// (maxAdvanceDays, 0 = no limit) capped so an unlimited horizon stays cheap.
export const STRIP_CAP_DAYS = 180;
export function stripLimit(settings) {
  const max = Math.max(0, Number(settings?.maxAdvanceDays ?? 60));
  return max > 0 ? Math.min(max + 1, STRIP_CAP_DAYS) : STRIP_CAP_DAYS;
}

// [{ date, dateISO, status, slots (available only), allSlots }] for `count`
// days starting at `from`. `slotsFn` is injectable for tests.
export function buildDays(cal, svc, from, count, slotsFn = slotsForDate) {
  const out = [];
  if (!cal || !svc || !(from instanceof Date)) return out;
  for (let i = 0; i < count; i++) {
    const date = addDays(from, i);
    const allSlots = slotsFn(cal, date, svc) || [];
    out.push({
      date,
      dateISO: fmtDateISO(date),
      status: dayStatus(allSlots),
      slots: allSlots.filter((s) => s.available),
      allSlots,
    });
  }
  return out;
}

// First bookable time from `from` forward, looking at most `days` days ahead.
// → { date, dateISO, slot, index } or null. `index` is the day offset.
export function findNextAvailable(cal, svc, from, days, slotsFn = slotsForDate) {
  if (!cal || !svc || !(from instanceof Date)) return null;
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const slots = slotsFn(cal, date, svc) || [];
    const first = slots.filter((s) => s.available).sort((a, b) => a.start - b.start)[0];
    if (first) return { date, dateISO: fmtDateISO(date), slot: first, index: i };
  }
  return null;
}

// ── Labels ──────────────────────────────────────────────────────────────
const DAY_FMT = { weekday: 'short', month: 'short', day: 'numeric' };
// "Thu, Nov 5"
export function shortDate(date) {
  return date.toLocaleDateString('en-US', DAY_FMT);
}
// "Thursday, November 5"
export function longDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
// "Thu, Nov 5 at 9:00 am"
export function nextAvailableLabel(next) {
  if (!next) return '';
  return `${shortDate(next.date)} at ${minToHM(next.slot.start)}`;
}

// 30 → "30 min", 60 → "1 hr", 90 → "1 hr 30 min"
export function fmtDuration(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

// 95 → "$95", 95.5 → "$95.50", 0 → "Free"
export function fmtPrice(n, { zero = 'Free' } = {}) {
  const v = Number(n) || 0;
  if (v <= 0) return zero;
  return '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

// ── Time zones ──────────────────────────────────────────────────────────
function wallClock(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short',
  }).formatToParts(new Date(ms));
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  const hour = p.hour === '24' ? '12' : p.hour;
  return {
    dateISO: `${p.year}-${p.month}-${p.day}`,
    time: `${hour}:${p.minute} ${String(p.dayPeriod || '').toLowerCase()}`.trim(),
    weekday: p.weekday,
  };
}

// Short zone name ("PST", "GMT+1") for a zone at an instant.
export function zoneShortName(tz, ms = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value || null;
  } catch { return null; }
}

// The same slot in the visitor's own zone. Times on the page are always the
// business's wall clock; when the visitor's browser is somewhere else we also
// say what that is for them.
//   → { differs: false } when there is nothing to add
//   → { differs: true, viewer: '9:00 am', viewerFull: 'Wed 11:00 pm' (weekday
//       only when the date changes), business: '12:00 pm' }
export function zoneTimes({ dateISO, startMin, bizTz, viewerTz }) {
  if (!bizTz || !viewerTz || !dateISO || !Number.isFinite(Number(startMin))) return { differs: false };
  if (!isValidTimeZone(bizTz) || !isValidTimeZone(viewerTz)) return { differs: false };
  try {
    const ms = zonedTimeToUtcMs(dateISO, Number(startMin), bizTz);
    const v = wallClock(ms, viewerTz);
    const business = minToHM(Number(startMin));
    if (v.dateISO === String(dateISO).slice(0, 10) && v.time === business) return { differs: false };
    const sameDay = v.dateISO === String(dateISO).slice(0, 10);
    return {
      differs: true,
      viewer: v.time,
      viewerFull: sameDay ? v.time : `${v.weekday} ${v.time}`,
      business,
    };
  } catch {
    return { differs: false };
  }
}

// "9:00 am your time / 12:00 pm Maple Studio's time", or just "12:00 pm".
export function dualTimeLabel({ dateISO, startMin, bizTz, viewerTz, bizName }) {
  const z = zoneTimes({ dateISO, startMin, bizTz, viewerTz });
  const business = minToHM(Number(startMin));
  if (!z.differs) return business;
  const who = bizName ? `${bizName}'s time` : 'their time';
  return `${z.viewerFull} your time / ${business} ${who}`;
}

// ── Deep links ──────────────────────────────────────────────────────────
// ?service=<id or slug>. Matches a service id exactly (case-insensitive) or
// the slugified service name. Returns the service or null. Input is capped
// so a hostile URL cannot make this expensive.
export function resolveServiceParam(services, param) {
  if (!Array.isArray(services) || param == null) return null;
  const raw = String(param).trim().slice(0, 120);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const byId = services.find((s) => String(s.id).toLowerCase() === lower);
  if (byId) return byId;
  const want = slugify(raw);
  if (!want) return null;
  return services.find((s) => slugify(s.name) === want) || null;
}

// The slug used in ?service= links for a service.
export function serviceSlug(service) {
  return slugify(service?.name || '');
}

// Services shown in the list. 'private' services are hidden from the page
// ("Bookable by anyone you give the direct link to"), except the one a deep
// link selected.
export function listedServices(services, selectedId = null) {
  return (Array.isArray(services) ? services : []).filter(
    (s) => (s.visibility || 'public') !== 'private' || (selectedId && s.id === selectedId),
  );
}

// Case-insensitive name/description search for the service list.
export function filterServices(services, query) {
  const q = String(query || '').trim().toLowerCase().slice(0, 80);
  if (!q) return services;
  return services.filter((s) =>
    String(s.name || '').toLowerCase().includes(q)
    || String(s.description || '').toLowerCase().includes(q));
}

// ── Policy ──────────────────────────────────────────────────────────────
// Plain-language deposit / cancellation / no-show lines for one service,
// built only from what the owner configured. Empty array = no policy.
export function policyLines(svc, total = null) {
  if (!svc) return [];
  const out = [];
  const price = Number(total ?? svc.price ?? 0);
  const type = svc.depositType || 'none';
  const amt = Number(svc.depositAmount || 0);
  if (price > 0 && type === 'full') {
    out.push('Paid in full when you book.');
  } else if (price > 0 && type === 'percent' && amt > 0) {
    const due = Math.round(price * Math.min(100, amt)) / 100;
    out.push(`A ${fmtPrice(due)} deposit (${amt}%) is due when you book.`);
  } else if (price > 0 && type === 'fixed' && amt > 0) {
    out.push(`A ${fmtPrice(Math.min(amt, price))} deposit is due when you book.`);
  }
  const fee = Number(svc.cancellationFeeAmount || 0);
  const hours = Number.isInteger(svc.cancellationWindowHours) ? svc.cancellationWindowHours : 24;
  if (fee > 0) {
    const win = hours % 24 === 0 && hours >= 24
      ? `${hours / 24} day${hours === 24 ? '' : 's'}`
      : `${hours} hour${hours === 1 ? '' : 's'}`;
    out.push(`Cancelling within ${win} of your appointment may come with a ${fmtPrice(fee)} fee.`);
  }
  const noShow = Number(svc.noShowFeeAmount || 0);
  if (noShow > 0) out.push(`Missing your appointment may come with a ${fmtPrice(noShow)} fee.`);
  return out;
}

// ── Contact ─────────────────────────────────────────────────────────────
export function mapsUrl(address) {
  const a = String(address || '').trim().slice(0, 300);
  return a ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}` : null;
}
export function telHref(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '').slice(0, 20);
  return digits.replace(/\D/g, '').length >= 7 ? `tel:${digits}` : null;
}

// ── Returning visitor (this device only) ────────────────────────────────
export const REMEMBER_KEY = 'ivy.booking.me';
export function readRemembered(storage) {
  try {
    const raw = storage?.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const name = typeof v?.name === 'string' ? v.name.slice(0, 120) : '';
    const email = typeof v?.email === 'string' ? v.email.slice(0, 200) : '';
    const phone = typeof v?.phone === 'string' ? v.phone.slice(0, 40) : '';
    if (!name && !email) return null;
    return { name, email, phone };
  } catch { return null; }
}
export function writeRemembered(storage, { name, email, phone }) {
  try {
    storage?.setItem(REMEMBER_KEY, JSON.stringify({
      name: String(name || '').slice(0, 120),
      email: String(email || '').slice(0, 200),
      phone: String(phone || '').slice(0, 40),
    }));
    return true;
  } catch { return false; }
}
export function forgetRemembered(storage) {
  try { storage?.removeItem(REMEMBER_KEY); } catch { /* storage blocked */ }
}
