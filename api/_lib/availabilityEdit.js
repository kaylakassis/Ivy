// Changing part of the weekly schedule without touching the rest.
//
// calendar_settings.availability is { "0".."6": [{ start, end }] } in minutes
// from midnight, 0 = Sunday (see validateAvailability in settingsValidation.js).
// Ivy's adjust_availability tool takes a short list of per-day changes
// ("close Tuesday 1 to 2 pm", "open Saturday 10 to 2") and applies them to the
// schedule as it is at that moment: closing a window splits the open hours
// around it, opening one merges it into what is already open, and every day
// that is not named stays exactly as it was. set_availability (the full
// replace) is a separate, explicit tool.
//
// Everything here is pure: no database, no clock. The tool executor and the
// approval card both use it, and the tests call it directly.
import { validateAvailability } from './settingsValidation.js';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Monday first, the way owners read a week.
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const MAX_AVAILABILITY_CHANGES = 14;

const DAY_ALIASES = {
  sun: 0, sunday: 0, sundays: 0,
  mon: 1, monday: 1, mondays: 1,
  tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6,
};

export function dayIndex(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 && raw <= 6 ? raw : null;
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^[0-6]$/.test(s)) return Number(s);
  return Object.prototype.hasOwnProperty.call(DAY_ALIASES, s) ? DAY_ALIASES[s] : null;
}

export function fmtClock(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return '?';
  if (n === 1440) return '12:00 AM (midnight)';
  const h = Math.floor(n / 60), mm = n % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
  return `${h12}:${String(mm).padStart(2, '0')} ${period}`;
}

export function fmtWindows(wins) {
  if (!Array.isArray(wins) || wins.length === 0) return 'closed';
  return wins.map((w) => `${fmtClock(w.start)} to ${fmtClock(w.end)}`).join(' and ');
}

// Sorted, overlapping or touching windows joined.
export function mergeWindows(wins) {
  const list = (Array.isArray(wins) ? wins : [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.start < w.end)
    .map((w) => ({ start: w.start, end: w.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const w of list) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

// Open hours minus one closed window: 9-17 minus 13-14 is 9-13 and 14-17.
export function subtractWindow(wins, cut) {
  const out = [];
  for (const w of mergeWindows(wins)) {
    if (cut.end <= w.start || cut.start >= w.end) { out.push(w); continue; }
    if (cut.start > w.start) out.push({ start: w.start, end: cut.start });
    if (cut.end < w.end) out.push({ start: cut.end, end: w.end });
  }
  return out;
}

// Validates the tool input. Returns { changes: [{ day, action, start, end, wholeDay }] }
// or { error } with a sentence the model can repeat to the owner.
export function parseAvailabilityChanges(input) {
  const list = Array.isArray(input?.changes) ? input.changes : null;
  if (!list || list.length === 0) return { error: 'changes must be a list of at least one { day, action, start_min, end_min }' };
  if (list.length > MAX_AVAILABILITY_CHANGES) return { error: `At most ${MAX_AVAILABILITY_CHANGES} changes at once` };
  const changes = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || typeof c !== 'object') return { error: `change ${i + 1} must be an object` };
    const day = dayIndex(c.day);
    if (day == null) return { error: `change ${i + 1}: "${String(c.day ?? '').slice(0, 20)}" is not a day of the week (use monday..sunday or 0-6, 0 = Sunday)` };
    const action = String(c.action || '').toLowerCase();
    if (action !== 'close' && action !== 'open') return { error: `change ${i + 1}: action must be "close" or "open"` };
    const hasStart = c.start_min != null && c.start_min !== '';
    const hasEnd = c.end_min != null && c.end_min !== '';
    if (!hasStart && !hasEnd) {
      if (action === 'open') return { error: `change ${i + 1}: opening hours needs start_min and end_min` };
      changes.push({ day, action, start: 0, end: 1440, wholeDay: true });
      continue;
    }
    const start = Number(c.start_min), end = Number(c.end_min);
    if (!hasStart || !hasEnd || !Number.isInteger(start) || !Number.isInteger(end)) {
      return { error: `change ${i + 1}: start_min and end_min must both be whole minutes from midnight (for example 780 = 1:00 PM)` };
    }
    if (start < 0 || end > 1440 || start >= end) return { error: `change ${i + 1}: the time window must satisfy 0 <= start_min < end_min <= 1440` };
    changes.push({ day, action, start, end, wholeDay: start === 0 && end === 1440 });
  }
  return { changes };
}

// Applies parsed changes to the current schedule. Days that are not named
// keep their exact stored value. Returns { value, touched: [dayIndex] } or
// { error } when the current schedule cannot be read.
export function applyAvailabilityChanges(current, changes) {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const v = validateAvailability(base);
  if (v.error) return { error: `the current weekly schedule could not be read (${v.error})` };
  const next = { ...v.value };
  const touched = [];
  for (const c of changes) {
    const key = String(c.day);
    const wins = next[key] || [];
    next[key] = c.action === 'close'
      ? subtractWindow(wins, { start: c.start, end: c.end })
      : mergeWindows([...wins, { start: c.start, end: c.end }]);
    if (!touched.includes(c.day)) touched.push(c.day);
  }
  const check = validateAvailability(next);
  if (check.error) return { error: check.error };
  return { value: check.value, touched };
}

function sameWindows(a, b) {
  const x = mergeWindows(a), y = mergeWindows(b);
  return x.length === y.length && x.every((w, i) => w.start === y[i].start && w.end === y[i].end);
}

// Per-day before/after for every day whose hours differ.
export function diffAvailability(before, after) {
  const b = validateAvailability(before || {}).value || {};
  const a = validateAvailability(after || {}).value || {};
  const changed = [];
  const unchanged = [];
  for (const d of WEEK_ORDER) {
    const from = b[String(d)] || [];
    const to = a[String(d)] || [];
    if (sameWindows(from, to)) unchanged.push(d);
    else changed.push({ day: d, from: mergeWindows(from), to: mergeWindows(to) });
  }
  return { changed, unchanged };
}

export function describeChange(c) {
  const day = DAY_NAMES[c.day];
  if (c.action === 'close') {
    return c.wholeDay ? `close ${day} for the whole day` : `close ${day} ${fmtClock(c.start)} to ${fmtClock(c.end)}`;
  }
  return `open ${day} ${fmtClock(c.start)} to ${fmtClock(c.end)}`;
}

// Owner-readable weekly schedule, Monday first.
export function scheduleByDay(avail) {
  const v = validateAvailability(avail || {}).value || {};
  const out = {};
  for (const d of WEEK_ORDER) out[DAY_NAMES[d].toLowerCase()] = fmtWindows(mergeWindows(v[String(d)] || []));
  return out;
}
