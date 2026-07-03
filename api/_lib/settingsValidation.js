// Shared validation for calendar_settings writes — the single source of truth
// used by BOTH the HTTP PATCH handler (api/calendar/index.js) and Ivy's write
// tools (api/_lib/ivyTools.js). Before this, the PATCH handler validated inline
// and Ivy's update_settings had a DRIFTED copy (looser slug regex, missing
// fields). Each validator returns { value } on success or { error } (a
// human-readable message) — no throwing, so callers map it to their own 400 /
// tool-error shape.
import { DISCOVER_CATEGORY_SET } from './calendar.js';
import { isValidTimeZone } from './tz.js';

// Weekly-availability presets in the canonical API shape (weekday index string
// 0=Sun … 6=Sat → array of {start,end} minutes-from-midnight). Ported from the
// client-side onboarding presets so an Ivy tool can accept "weekdays" etc.
const NINE_TO_FIVE = [{ start: 9 * 60, end: 17 * 60 }];
export const AVAILABILITY_PRESETS = {
  weekdays: { 1: NINE_TO_FIVE, 2: NINE_TO_FIVE, 3: NINE_TO_FIVE, 4: NINE_TO_FIVE, 5: NINE_TO_FIVE },
  everyday: { 0: NINE_TO_FIVE, 1: NINE_TO_FIVE, 2: NINE_TO_FIVE, 3: NINE_TO_FIVE, 4: NINE_TO_FIVE, 5: NINE_TO_FIVE, 6: NINE_TO_FIVE },
  weekends: { 0: NINE_TO_FIVE, 6: NINE_TO_FIVE },
};

// Map friendly weekday names an LLM might emit to the canonical 0–6 index.
const WEEKDAY_ALIASES = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

// Validate the weekly-availability object. Accepts either canonical numeric-
// string keys ("0".."6") or day-name keys ("monday"), normalizing to the
// canonical shape. Returns { value } (canonical) or { error }.
export function validateAvailability(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'availability must be an object of weekday -> [{start,end}] windows' };
  }
  const out = {};
  for (const rawKey of Object.keys(input)) {
    let idx;
    if (/^[0-6]$/.test(rawKey)) idx = Number(rawKey);
    else if (rawKey.toLowerCase() in WEEKDAY_ALIASES) idx = WEEKDAY_ALIASES[rawKey.toLowerCase()];
    else return { error: `availability key "${rawKey}" is not a weekday (use 0-6 or a day name)` };

    const windows = input[rawKey];
    if (!Array.isArray(windows)) return { error: `availability for ${rawKey} must be an array of windows` };
    const clean = [];
    for (const w of windows) {
      if (!w || typeof w !== 'object') return { error: 'each availability window must be a {start,end} object' };
      if (!Number.isInteger(w.start) || !Number.isInteger(w.end)) {
        return { error: 'window start/end must be integer minutes from midnight (e.g. 540 = 9:00am)' };
      }
      if (w.start < 0 || w.end > 24 * 60 || w.start >= w.end) {
        return { error: 'window must satisfy 0 <= start < end <= 1440' };
      }
      clean.push({ start: w.start, end: w.end });
    }
    out[String(idx)] = clean;
  }
  return { value: out };
}

// Resolve a preset name to a canonical availability object, or { error }.
export function availabilityFromPreset(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!AVAILABILITY_PRESETS[key]) {
    return { error: `unknown preset "${name}" (use one of: ${Object.keys(AVAILABILITY_PRESETS).join(', ')})` };
  }
  // Normalize numeric keys to strings for storage consistency.
  const preset = AVAILABILITY_PRESETS[key];
  const out = {};
  for (const k of Object.keys(preset)) out[String(k)] = preset[k];
  return { value: out };
}

// Booking-rule fields. Only the keys present in `fields` are validated/returned;
// returns { patch } (db-column -> value) or { error }. Mirrors the PATCH handler
// bounds exactly.
export function validateBookingRules(fields) {
  const patch = {};
  const f = fields || {};
  if (f.slotMinutes != null) {
    const n = Number(f.slotMinutes);
    if (![5, 10, 15, 20, 30, 45, 60].includes(n)) return { error: 'slotMinutes must be one of 5, 10, 15, 20, 30, 45, 60' };
    patch.slot_minutes = n;
  }
  if (f.bufferMinutes != null) {
    const n = Number(f.bufferMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 240) return { error: 'bufferMinutes must be an integer 0-240' };
    patch.buffer_minutes = n;
  }
  if (f.minNoticeHours != null) {
    const n = Number(f.minNoticeHours);
    if (!Number.isInteger(n) || n < 0 || n > 720) return { error: 'minNoticeHours must be an integer 0-720' };
    patch.min_notice_hours = n;
  }
  if (f.maxAdvanceDays != null) {
    const n = Number(f.maxAdvanceDays);
    if (!Number.isInteger(n) || n < 0 || n > 730) return { error: 'maxAdvanceDays must be an integer 0-730' };
    patch.max_advance_days = n;
  }
  if (f.slotFitService != null) {
    patch.slot_fit_service = !!f.slotFitService;
  }
  return { patch };
}

// Business-identity fields (NOT slug — that needs a DB uniqueness check the
// caller performs). Only present keys are returned. { patch } or { error }.
export function validateBusinessBasics(fields) {
  const patch = {};
  const f = fields || {};
  if ('bizName' in f) {
    const v = (f.bizName == null ? '' : String(f.bizName)).trim().slice(0, 120);
    if (!v) return { error: 'business name cannot be empty' };
    patch.biz_name = v;
  }
  if ('tagline' in f) {
    const t = f.tagline == null ? null : String(f.tagline).trim().slice(0, 140);
    patch.tagline = t || null;
  }
  if ('timezone' in f) {
    const tz = f.timezone == null || f.timezone === '' ? null : String(f.timezone).trim();
    if (tz && !isValidTimeZone(tz)) return { error: `"${tz}" is not a valid IANA timezone (e.g. America/New_York)` };
    patch.timezone = tz;
  }
  if ('category' in f) {
    const c = f.category == null ? null : String(f.category).trim();
    if (c && !DISCOVER_CATEGORY_SET.has(c)) {
      return { error: `invalid category (choose one of: ${[...DISCOVER_CATEGORY_SET].join(', ')})` };
    }
    patch.category = c || null;
  }
  return { patch };
}
