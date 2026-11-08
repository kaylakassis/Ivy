// Pure helpers for shop pages (/shop/:slug). No React, no DOM, so the
// server renderer (api/_lib/shopHtml.js) and the tests
// (tests/shop-helpers.test.mjs) use the very same code as the page.
//
// A "member" is one entry of the public shop payload: its own settings,
// listed services, blocks and redacted bookings, which is exactly the
// shape the public booking page feeds to slotsForDate. So "next available"
// and "first available across the shop" reuse the booking page's slot
// math and can never disagree with what that pro's own page would show.
import { slotsForDate, fmtDateISO, addDays, minToHM, parseISO } from '../calendar/utils.js';
import { findNextAvailable, stripLimit, fmtPrice, fmtDuration } from '../calendar/publicBookingHelpers.js';
import { zonedTimeToUtcMs, zonedParts, isValidTimeZone } from '../../lib/tz.js';

export { fmtPrice, fmtDuration, minToHM };

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_WORDS = {
  sunday: 0, sundays: 0, sun: 0, monday: 1, mondays: 1, mon: 1, tuesday: 2, tuesdays: 2, tue: 2, tues: 2,
  wednesday: 3, wednesdays: 3, wed: 3, thursday: 4, thursdays: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fridays: 5, fri: 5, saturday: 6, saturdays: 6, sat: 6,
};

// The slice of a member the slot math reads.
export function memberCal(m) {
  return { settings: m?.settings || {}, services: m?.services || [], blocks: m?.blocks || [], bookings: m?.bookings || [] };
}

const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Services across the shop, one row per service name. The same name
// offered by several pros merges into one row with the lowest price
// ("from $X") and every pro who offers it.
export function groupServices(members) {
  const map = new Map();
  for (const m of (Array.isArray(members) ? members : [])) {
    for (const s of (m.services || [])) {
      const key = normName(s.name);
      if (!key) continue;
      let g = map.get(key);
      if (!g) {
        g = { key, name: String(s.name).trim(), fromPrice: null, maxPrice: null, minDuration: null, hidePrice: false, members: [], entries: [], categories: new Set() };
        map.set(key, g);
      }
      const price = s.hidePrice ? null : Number(s.price || 0);
      if (s.hidePrice) g.hidePrice = true;
      if (price != null) {
        g.fromPrice = g.fromPrice == null ? price : Math.min(g.fromPrice, price);
        g.maxPrice = g.maxPrice == null ? price : Math.max(g.maxPrice, price);
      }
      const dur = Number(s.durationMinutes || 0);
      g.minDuration = g.minDuration == null ? dur : Math.min(g.minDuration, dur);
      if (!g.members.some((x) => x.id === m.id)) g.members.push({ id: m.id, firstName: m.firstName || m.businessName, businessName: m.businessName });
      g.entries.push({ memberId: m.id, serviceId: s.id, price, durationMinutes: dur });
      if (m.settings?.category) g.categories.add(m.settings.category);
    }
  }
  return [...map.values()]
    .map((g) => ({ ...g, fromPrice: g.fromPrice == null ? 0 : g.fromPrice, maxPrice: g.maxPrice == null ? 0 : g.maxPrice, categories: [...g.categories] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Groups → sections by the pros' business category when the shop spans
// more than one; a single category gives one unnamed section.
export function sectionServices(groups) {
  const cats = new Set();
  for (const g of groups) for (const c of g.categories) cats.add(c);
  if (cats.size <= 1) return [{ title: null, groups }];
  const out = new Map();
  for (const g of groups) {
    const title = g.categories[0] || 'Other';
    if (!out.has(title)) out.set(title, []);
    out.get(title).push(g);
  }
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([title, gs]) => ({ title, groups: gs }));
}

const epochOf = (dateISO, start, tz) => zonedTimeToUtcMs(dateISO, start, tz || undefined);

// The soonest bookable time for one pro + one of their services.
// → { member, service, dateISO, slot, ms } or null.
export function nextForMember(member, service, from = new Date()) {
  if (!member || !service) return null;
  const cal = memberCal(member);
  const next = findNextAvailable(cal, service, from, stripLimit(cal.settings));
  if (!next) return null;
  return { member, service, dateISO: next.dateISO, slot: next.slot, ms: epochOf(next.dateISO, next.slot.start, cal.settings.timezone) };
}

// The soonest time a pro has for ANY of their listed services (team card).
export function nextForMemberAny(member, from = new Date()) {
  let best = null;
  for (const s of (member?.services || [])) {
    const n = nextForMember(member, s, from);
    if (n && (!best || n.ms < best.ms)) best = n;
  }
  return best;
}

// First available across the shop for one service name: the true soonest
// slot among every pro who offers it. Ties go to the pro listed first.
export function firstAvailable(group, members, from = new Date()) {
  if (!group) return null;
  const byId = new Map((members || []).map((m) => [m.id, m]));
  let best = null;
  for (const e of group.entries) {
    const m = byId.get(e.memberId);
    const s = (m?.services || []).find((x) => x.id === e.serviceId);
    const n = nextForMember(m, s, from);
    if (n && (!best || n.ms < best.ms)) best = n;
  }
  return best;
}

// Every open time for a service across the shop over the next `days`
// days, soonest first, capped at `max`.
export function weekSlots(group, members, from = new Date(), { days = 7, max = 40 } = {}) {
  if (!group) return [];
  const byId = new Map((members || []).map((m) => [m.id, m]));
  const out = [];
  for (const e of group.entries) {
    const m = byId.get(e.memberId);
    const s = (m?.services || []).find((x) => x.id === e.serviceId);
    if (!m || !s) continue;
    const cal = memberCal(m);
    for (let i = 0; i < days; i++) {
      const date = addDays(from, i);
      const dateISO = fmtDateISO(date);
      for (const sl of slotsForDate(cal, date, s)) {
        if (!sl.available) continue;
        out.push({ member: m, service: s, dateISO, start: sl.start, end: sl.end, ms: epochOf(dateISO, sl.start, cal.settings.timezone) });
      }
    }
  }
  return out.sort((a, b) => a.ms - b.ms || String(a.member.id).localeCompare(String(b.member.id))).slice(0, max);
}

// "today", "tomorrow" or "Thu, Nov 12" relative to the shop's own day.
export function relativeDay(dateISO, tz, now = new Date()) {
  const t = zonedParts(tz || undefined, now);
  const todayISO = `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
  if (dateISO === todayISO) return 'today';
  const tomorrow = addDays(parseISO(todayISO), 1);
  if (dateISO === fmtDateISO(tomorrow)) return 'tomorrow';
  return parseISO(dateISO).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// "Next: today 3:30 pm"
export function nextLabel(next, tz, now = new Date()) {
  if (!next) return 'No open times right now';
  const day = relativeDay(next.dateISO, tz, now);
  return `Next: ${day} ${minToHM(next.slot ? next.slot.start : next.start)}`;
}

// Open / closed right now from the shop hours ({"0":[{start,end}],...}) in
// the shop's time zone. → { open, label }
export function openStatus(hours, tz, now = new Date()) {
  const h = hours && typeof hours === 'object' ? hours : {};
  const anyHours = Object.values(h).some((l) => Array.isArray(l) && l.length);
  if (!anyHours) return { open: false, label: '' };
  const p = zonedParts(isValidTimeZone(tz) ? tz : undefined, now);
  const nowMin = Number(p.minutes) || 0;
  const today = (h[String(p.weekday)] || []).slice().sort((a, b) => a.start - b.start);
  for (const w of today) {
    if (nowMin >= w.start && nowMin < w.end) return { open: true, label: `Open until ${minToHM(w.end)}` };
  }
  const later = today.find((w) => w.start > nowMin);
  if (later) return { open: false, label: `Opens at ${minToHM(later.start)}` };
  for (let i = 1; i <= 7; i++) {
    const d = (p.weekday + i) % 7;
    const list = (h[String(d)] || []).slice().sort((a, b) => a.start - b.start);
    if (list.length) return { open: false, label: `Closed now. Opens ${i === 1 ? 'tomorrow' : WEEKDAYS[d]} at ${minToHM(list[0].start)}` };
  }
  return { open: false, label: 'Closed' };
}

// [{ day: 'Monday', text: '9:00 am to 5:00 pm' }], Monday first.
export function hoursLines(hours) {
  const h = hours && typeof hours === 'object' ? hours : {};
  const out = [];
  for (let i = 1; i <= 7; i++) {
    const d = i % 7;
    const list = (h[String(d)] || []).slice().sort((a, b) => a.start - b.start);
    out.push({ day: WEEKDAYS[d], weekday: d, text: list.length ? list.map((w) => `${minToHM(w.start)} to ${minToHM(w.end)}`).join(', ') : 'Closed' });
  }
  return out;
}

// Count-weighted shop rating from each member's own count + average.
// → { count, avg } (avg null when there are no reviews). Never rounds up
// past the real weighted mean.
export function shopRating(members) {
  let count = 0, sum = 0;
  for (const m of (members || [])) {
    const n = Number(m.reviews?.count || 0);
    const avg = Number(m.reviews?.avg || 0);
    if (n > 0 && avg > 0) { count += n; sum += n * avg; }
  }
  return { count, avg: count ? Math.round((sum / count) * 100) / 100 : null };
}

// Reads a weekday out of free text ("fades on Saturdays" → 6), else null.
export function weekdayFromText(text) {
  for (const word of String(text || '').toLowerCase().split(/[^a-z]+/)) {
    if (word in WEEKDAY_WORDS) return WEEKDAY_WORDS[word];
  }
  return null;
}

// Does this pro open on `weekday` for `service` (service hours can only
// narrow the pro's general hours)?
export function worksOn(member, service, weekday) {
  if (weekday == null) return true;
  const ws = member?.settings?.availability?.[String(weekday)] || [];
  if (!ws.length) return false;
  const svc = service?.availability?.[String(weekday)];
  if (svc == null) return true;
  return svc.length > 0 && ws.some((a) => svc.some((b) => Math.max(a.start, b.start) < Math.min(a.end, b.end)));
}

// Guided search over the team: service words + an optional weekday.
// "Who does fades on Saturdays?" → the pros whose listed services match
// "fades" and who open on Saturdays. Weekday words are stripped from the
// service query. → { weekday, query, matches: [{ member, services }] }
export function searchTeam(members, text, weekdayOverride = null) {
  const raw = String(text || '').slice(0, 120);
  const weekday = weekdayOverride != null ? weekdayOverride : weekdayFromText(raw);
  const stop = new Set(['who', 'does', 'do', 'on', 'a', 'an', 'the', 'for', 'me', 'i', 'want', 'need', 'can', 'get', 'with', 'at', 'in', 'is', 'there', 'anyone', 'someone', 'available', 'open', 'book', 'and', 'or', 'please', 'any']);
  const words = raw.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !stop.has(w) && !(w in WEEKDAY_WORDS));
  const stem = (w) => w.replace(/(ies|es|s)$/, (m) => (m === 'ies' ? 'y' : ''));
  const stems = words.map(stem).filter(Boolean);
  const matches = [];
  for (const m of (members || [])) {
    const hay = (s) => normName(`${s.name} ${s.description || ''}`);
    let services = (m.services || []).filter((s) => worksOn(m, s, weekday));
    if (stems.length) {
      services = services.filter((s) => {
        const h = hay(s);
        return stems.some((st) => h.includes(st));
      });
    }
    if (!services.length) continue;
    if (!stems.length && weekday == null) continue;
    matches.push({ member: m, services });
  }
  return { weekday, query: words.join(' '), matches };
}
