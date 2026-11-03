// Calendar file (.ics, RFC 5545) reader for "switching to Ivy": turns the
// events in an exported calendar into appointment candidates the owner can
// bring in as bookings. No dependency; defensive by design:
//
//   • Input is capped (ICS_MAX_BYTES) and every value is length-capped.
//   • No regex here can backtrack badly: line handling is split/indexOf,
//     property lines are scanned once, and the few regexes are anchored with
//     no nested or overlapping quantifiers.
//   • Recurring events (RRULE) are expanded for the import window only, with
//     a hard occurrence cap (MAX_OCCURRENCES) and a global step budget, so a
//     hostile rule (every day since 1900, COUNT=10^9) finishes in milliseconds.
//   • Nothing from the file is ever treated as HTML or as instructions; the
//     result is plain strings.
//
// Times: a DTSTART with TZID is wall-clock in that zone (Windows zone names
// from Outlook are mapped); 'Z' is UTC; a time with neither is floating and
// read in the workspace's zone, like an all-day date. Bookings are stored as
// wall-clock in the workspace zone, so every instant is converted back to it.
import crypto from 'node:crypto';
import { zonedTimeToUtcMs, zonedParts, isValidTimeZone, todayISOInZone } from './tz.js';

export const ICS_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_OCCURRENCES = 500;
export const MAX_PAST_LISTED = 100;
export const WINDOW_DAYS = 365;
const MAX_VEVENTS = 5000;
const STEP_BUDGET = 100_000;
// Upcoming candidates kept before sorting (the soonest MAX_OCCURRENCES are returned).
const MAX_CANDIDATES = 3000;
const DAY_MS = 86_400_000;
const TEXT_MAX = { summary: 300, description: 2000, location: 300, uid: 1000, name: 120, email: 254 };

// ── Lines ────────────────────────────────────────────────────────────

// RFC 5545 §3.1: a line starting with a space or tab continues the previous
// one. Collected as parts and joined once, so a long folded value is linear.
export function unfoldLines(text) {
  const raw = String(text).split(/\r\n|\n|\r/);
  const out = [];
  let cur = null;
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && cur) {
      cur.push(line.slice(1));
    } else {
      if (cur) out.push(cur.join(''));
      cur = [line];
    }
  }
  if (cur) out.push(cur.join(''));
  return out;
}

// NAME;PARAM=a;PARAM2="quoted:value":VALUE → { name, params, value }.
// One left-to-right pass; quotes protect ':' and ';' inside parameter values.
export function parsePropertyLine(line) {
  const s = String(line);
  let i = 0;
  const n = s.length;
  while (i < n && s[i] !== ';' && s[i] !== ':') i++;
  const name = s.slice(0, i).trim().toUpperCase();
  if (!name || i >= n) return null;
  const params = {};
  while (i < n && s[i] === ';') {
    i++;
    const ps = i;
    while (i < n && s[i] !== '=' && s[i] !== ';' && s[i] !== ':') i++;
    const pname = s.slice(ps, i).trim().toUpperCase();
    let pval = '';
    if (i < n && s[i] === '=') {
      i++;
      const parts = [];
      for (;;) {
        if (s[i] === '"') {
          const close = s.indexOf('"', i + 1);
          if (close === -1) { parts.push(s.slice(i + 1)); i = n; break; }
          parts.push(s.slice(i + 1, close));
          i = close + 1;
        } else {
          const vs = i;
          while (i < n && s[i] !== ';' && s[i] !== ':' && s[i] !== ',') i++;
          parts.push(s.slice(vs, i));
        }
        if (i < n && s[i] === ',') { i++; continue; }
        break;
      }
      pval = parts.join(',');
    }
    if (pname && !(pname in params)) params[pname] = pval.slice(0, 300);
  }
  if (i >= n || s[i] !== ':') return null;
  return { name, params, value: s.slice(i + 1) };
}

// TEXT unescape (§3.3.11): \n, \N, \, \; \\ — one pass.
function unescapeText(v, max) {
  return String(v || '')
    .slice(0, max * 2)
    .replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

// ── Time zones ───────────────────────────────────────────────────────

// Outlook / Exchange export Windows zone names instead of IANA ones.
const WINDOWS_TZ = {
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'central standard time': 'America/Chicago',
  'canada central standard time': 'America/Regina',
  'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix',
  'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage',
  'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax',
  'newfoundland standard time': 'America/St_Johns',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'gtb standard time': 'Europe/Bucharest',
  'israel standard time': 'Asia/Jerusalem',
  'arabian standard time': 'Asia/Dubai',
  'india standard time': 'Asia/Kolkata',
  'se asia standard time': 'Asia/Bangkok',
  'singapore standard time': 'Asia/Singapore',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'cen. australia standard time': 'Australia/Adelaide',
  'w. australia standard time': 'Australia/Perth',
  'new zealand standard time': 'Pacific/Auckland',
  'south africa standard time': 'Africa/Johannesburg',
  'sa pacific standard time': 'America/Bogota',
  'e. south america standard time': 'America/Sao_Paulo',
  'utc': 'UTC',
  'coordinated universal time': 'UTC',
};

// IANA name for a TZID, or null (then the time is read as floating).
export function resolveTimeZone(tzid) {
  const t = String(tzid || '').replace(/"/g, '').trim().slice(0, 120);
  if (!t) return null;
  if (isValidTimeZone(t)) return t;
  const win = WINDOWS_TZ[t.toLowerCase()];
  if (win) return win;
  // "/mozilla.org/20050126_1/America/New_York" and similar prefixes.
  const segs = t.split('/').filter(Boolean);
  for (const k of [3, 2]) {
    if (segs.length >= k) {
      const cand = segs.slice(-k).join('/');
      if (isValidTimeZone(cand)) return cand;
    }
  }
  return null;
}

// ── Dates ────────────────────────────────────────────────────────────

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function isoDate(y, m, d) { return `${pad(y, 4)}-${pad(m)}-${pad(d)}`; }
function dayNum(y, m, d) { return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS); }
function fromDayNum(n) {
  const dt = new Date(n * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

// → { kind: 'date'|'utc'|'zoned'|'floating', y, m, d, min, sec, tz } or null.
export function parseDateValue(value, params = {}) {
  const v = String(value || '').trim().split(',')[0];
  const mt = DT_RE.exec(v);
  if (!mt) return null;
  const y = +mt[1], m = +mt[2], d = +mt[3];
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  if (mt[4] === undefined || String(params.VALUE || '').toUpperCase() === 'DATE') {
    return { kind: 'date', y, m, d, min: 0, sec: 0, tz: null };
  }
  const hh = +mt[4], mi = +mt[5], ss = mt[6] ? +mt[6] : 0;
  if (hh > 23 || mi > 59 || ss > 60) return null;
  const min = hh * 60 + mi;
  if (mt[7]) return { kind: 'utc', y, m, d, min, sec: ss, tz: 'UTC' };
  const tz = params.TZID ? resolveTimeZone(params.TZID) : null;
  if (tz) return { kind: 'zoned', y, m, d, min, sec: ss, tz };
  return { kind: 'floating', y, m, d, min, sec: ss, tz: null };
}

// Absolute ms for a wall-clock (y, m, d, min) in a zone ('UTC' or IANA).
function wallToMs(y, m, d, min, zone) {
  if (zone === 'UTC') return Date.UTC(y, m - 1, d) + min * 60_000;
  return zonedTimeToUtcMs(isoDate(y, m, d), min, zone);
}
function zoneFor(dt, wsTz) {
  if (dt.kind === 'utc') return 'UTC';
  if (dt.kind === 'zoned') return dt.tz;
  return wsTz;
}
function dtToMs(dt, wsTz) {
  return wallToMs(dt.y, dt.m, dt.d, dt.min, zoneFor(dt, wsTz)) + (dt.kind === 'date' ? 0 : dt.sec * 1000);
}

const DUR_RE = /^([+-])?P(?:(\d{1,4})W)?(?:(\d{1,4})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,5})M)?(?:(\d{1,6})S)?)?$/;
export function parseDurationMs(v) {
  const mt = DUR_RE.exec(String(v || '').trim().toUpperCase());
  if (!mt || mt[1] === '-') return null;
  const ms = ((+(mt[2] || 0) * 7 + +(mt[3] || 0)) * 24 * 3600 + +(mt[4] || 0) * 3600 + +(mt[5] || 0) * 60 + +(mt[6] || 0)) * 1000;
  return ms > 0 ? ms : null;
}

// ── Recurrence ───────────────────────────────────────────────────────

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const SUPPORTED_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const BYDAY_RE = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/;

export function parseRrule(value) {
  const out = { freq: null, interval: 1, count: null, until: null, byday: [], bymonthday: [], wkst: 1, unsupported: false };
  for (const part of String(value || '').slice(0, 500).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim().toUpperCase();
    const v = part.slice(eq + 1).trim().toUpperCase();
    if (k === 'FREQ') out.freq = v;
    else if (k === 'INTERVAL') { const x = parseInt(v, 10); out.interval = Number.isFinite(x) && x >= 1 ? Math.min(x, 1000) : 1; }
    else if (k === 'COUNT') { const x = parseInt(v, 10); out.count = Number.isFinite(x) && x >= 1 ? Math.min(x, 1_000_000) : null; }
    else if (k === 'UNTIL') out.until = parseDateValue(v, {});
    else if (k === 'WKST') out.wkst = WD[v] ?? 1;
    else if (k === 'BYDAY') {
      for (const tok of v.split(',').slice(0, 14)) {
        const mt = BYDAY_RE.exec(tok.trim());
        if (mt) out.byday.push({ n: mt[1] ? parseInt(mt[1], 10) : 0, wd: WD[mt[2]] });
        else out.unsupported = true;
      }
    } else if (k === 'BYMONTHDAY') {
      for (const tok of v.split(',').slice(0, 31)) {
        const x = parseInt(tok, 10);
        if (Number.isFinite(x) && x !== 0 && x >= -31 && x <= 31) out.bymonthday.push(x);
        else out.unsupported = true;
      }
    } else if (k.startsWith('BY')) out.unsupported = true; // BYMONTH, BYSETPOS, BYHOUR…
  }
  if (!SUPPORTED_FREQ.has(out.freq)) out.unsupported = true;
  if (out.freq === 'DAILY' && (out.byday.length || out.bymonthday.length)) out.unsupported = true;
  if (out.freq === 'WEEKLY' && (out.bymonthday.length || out.byday.some((b) => b.n !== 0))) out.unsupported = true;
  if (out.freq === 'YEARLY' && (out.byday.length || out.bymonthday.length)) out.unsupported = true;
  return out;
}

// Candidate dates (day numbers, ascending) for period k of the rule.
function periodDates(rule, start, k) {
  if (rule.freq === 'DAILY') return [start.day + k * rule.interval];
  if (rule.freq === 'WEEKLY') {
    if (!rule.byday.length) return [start.day + k * 7 * rule.interval];
    // Week containing DTSTART, beginning on WKST. Day 0 (1970-01-01) was a Thursday.
    const wdStart = (start.day + 4) % 7;
    const anchor = start.day - ((wdStart - rule.wkst + 7) % 7);
    const weekStart = anchor + k * 7 * rule.interval;
    return rule.byday
      .map((b) => weekStart + ((b.wd - rule.wkst + 7) % 7))
      .sort((a, b) => a - b);
  }
  if (rule.freq === 'MONTHLY') {
    const mIndex = (start.y * 12 + (start.m - 1)) + k * rule.interval;
    const y = Math.floor(mIndex / 12), m = (mIndex % 12) + 1;
    const dim = daysInMonth(y, m);
    const days = new Set();
    if (rule.bymonthday.length) {
      for (const md of rule.bymonthday) {
        const d = md > 0 ? md : dim + md + 1;
        if (d >= 1 && d <= dim) days.add(d);
      }
    }
    if (rule.byday.length) {
      const firstWd = (dayNum(y, m, 1) + 4) % 7;
      for (const b of rule.byday) {
        const first = 1 + ((b.wd - firstWd + 7) % 7);
        const all = [];
        for (let d = first; d <= dim; d += 7) all.push(d);
        if (b.n === 0) all.forEach((d) => days.add(d));
        else {
          const d = b.n > 0 ? all[b.n - 1] : all[all.length + b.n];
          if (d) days.add(d);
        }
      }
    }
    if (!rule.bymonthday.length && !rule.byday.length && start.d <= dim) days.add(start.d);
    return [...days].sort((a, b) => a - b).map((d) => dayNum(y, m, d));
  }
  if (rule.freq === 'YEARLY') {
    const y = start.y + k * rule.interval;
    return start.d <= daysInMonth(y, start.m) ? [dayNum(y, start.m, start.d)] : [];
  }
  return [];
}

// Expands one recurring event. Yields occurrence start instants (ms) that
// fall in [fromMs, toMs], honoring COUNT / UNTIL / EXDATE, the per-file step
// budget and the occurrence cap. `budget` is { steps } shared across the file.
function expandRule({ rule, dtstart, wsTz, fromMs, toMs, exMs, exDates, skipMs, budget, cap }) {
  const zone = zoneFor(dtstart, wsTz);
  const start = { y: dtstart.y, m: dtstart.m, d: dtstart.d, day: dayNum(dtstart.y, dtstart.m, dtstart.d) };
  const startMs = dtToMs(dtstart, wsTz);
  const untilMs = rule.until ? dtToMs(rule.until.kind === 'date' ? { ...rule.until, min: 24 * 60 - 1 } : rule.until, wsTz) : null;
  const out = [];
  let produced = 0;
  let k = 0;
  // Skip whole periods that end before the window. With COUNT this is only
  // done when each period yields exactly one date, so COUNT stays exact.
  const onePerPeriod = rule.freq === 'DAILY' || rule.freq === 'YEARLY'
    || (rule.freq === 'WEEKLY' && !rule.byday.length)
    || (rule.freq === 'MONTHLY' && !rule.byday.length && !rule.bymonthday.length && start.d <= 28);
  if ((onePerPeriod || rule.count == null) && fromMs > startMs) {
    const avg = { DAILY: 1, WEEKLY: 7, MONTHLY: 30.436875, YEARLY: 365.2425 }[rule.freq] * rule.interval;
    const gap = (fromMs - startMs) / DAY_MS - 2 * avg - 2;
    if (gap > 0) {
      k = Math.floor(gap / avg);
      produced = onePerPeriod ? k : 0;
    }
  }
  for (;;) {
    if (budget.steps <= 0) { budget.exhausted = true; break; }
    budget.steps--;
    const dates = periodDates(rule, start, k);
    k++;
    let beyond = false;
    for (const dn of dates) {
      if (dn < start.day) continue;
      if (budget.steps <= 0) { budget.exhausted = true; beyond = true; break; }
      budget.steps--;
      if (rule.count != null && produced >= rule.count) { beyond = true; break; }
      const { y, m, d } = fromDayNum(dn);
      // Dates days before the window (and before UNTIL) only need counting;
      // the exact zone conversion is skipped for them.
      const approx = Date.UTC(y, m - 1, d) + dtstart.min * 60_000;
      if (approx + 2 * DAY_MS < fromMs && (untilMs == null || approx + 2 * DAY_MS < untilMs)) {
        produced++;
        continue;
      }
      const ms = wallToMs(y, m, d, dtstart.min, zone) + (dtstart.kind === 'date' ? 0 : dtstart.sec * 1000);
      if (ms < startMs) continue;
      if (untilMs != null && ms > untilMs) { beyond = true; break; }
      if (ms > toMs) { beyond = true; break; }
      produced++;
      if (ms < fromMs) continue;
      if (exMs.has(ms) || exDates.has(isoDate(y, m, d)) || skipMs.has(ms)) continue;
      out.push(ms);
      if (out.length >= cap) { beyond = true; break; }
    }
    if (beyond) break;
    if (k > 200_000) break;
  }
  return out;
}

// ── Events ───────────────────────────────────────────────────────────

function parseMailto(v) {
  const s = String(v || '').trim();
  const at = s.toLowerCase().startsWith('mailto:') ? s.slice(7) : s;
  const email = at.trim().toLowerCase().slice(0, TEXT_MAX.email);
  return /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(email) ? email : null;
}
function personFrom(prop) {
  const email = parseMailto(prop.value);
  let name = unescapeText(prop.params.CN || '', TEXT_MAX.name).replace(/^"|"$/g, '').trim();
  if (name && email && name.toLowerCase() === email) name = '';
  if (name && name.includes('@')) name = '';
  return {
    name: name || null,
    email,
    cutype: String(prop.params.CUTYPE || '').toUpperCase(),
  };
}

// Pulls VEVENT property bags out of the unfolded lines. Nested components
// (VALARM) are skipped. Returns { vevents, truncated }.
function collectVevents(lines) {
  const vevents = [];
  let cur = null;
  let nested = 0;
  let truncated = false;
  for (const line of lines) {
    if (!line) continue;
    const upper = line.length < 40 ? line.toUpperCase().trim() : '';
    if (upper.startsWith('BEGIN:')) {
      if (upper === 'BEGIN:VEVENT' && !cur && nested === 0) {
        if (vevents.length >= MAX_VEVENTS) { truncated = true; break; }
        cur = { props: [] };
      } else if (cur) nested++;
      continue;
    }
    if (upper.startsWith('END:')) {
      if (cur && nested > 0) nested--;
      else if (cur && upper === 'END:VEVENT') { vevents.push(cur); cur = null; }
      continue;
    }
    if (!cur || nested > 0) continue;
    if (cur.props.length >= 400) continue;
    const p = parsePropertyLine(line.length > 20_000 ? line.slice(0, 20_000) : line);
    if (p) cur.props.push(p);
  }
  return { vevents, truncated };
}

function shortKey(s) {
  const t = String(s);
  return t.length <= 200 ? t : `h:${crypto.createHash('sha256').update(t).digest('hex').slice(0, 40)}`;
}
function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function readEvent(ve) {
  const ev = { attendees: [], exdates: [], rrule: null };
  for (const p of ve.props) {
    switch (p.name) {
      case 'UID': if (!ev.uid) ev.uid = unescapeText(p.value, TEXT_MAX.uid); break;
      case 'SUMMARY': if (ev.summary == null) ev.summary = unescapeText(p.value, TEXT_MAX.summary); break;
      case 'DESCRIPTION': if (ev.description == null) ev.description = unescapeText(p.value, TEXT_MAX.description); break;
      case 'LOCATION': if (ev.location == null) ev.location = unescapeText(p.value, TEXT_MAX.location); break;
      case 'STATUS': ev.status = String(p.value).trim().toUpperCase().slice(0, 20); break;
      case 'DTSTART': if (!ev.dtstart) ev.dtstart = parseDateValue(p.value, p.params); break;
      case 'DTEND': if (!ev.dtend) ev.dtend = parseDateValue(p.value, p.params); break;
      case 'DURATION': if (ev.duration == null) ev.duration = parseDurationMs(p.value); break;
      case 'RRULE': if (!ev.rrule) ev.rrule = parseRrule(p.value); break;
      case 'RECURRENCE-ID': if (!ev.recurrenceId) ev.recurrenceId = parseDateValue(p.value, p.params); break;
      case 'EXDATE':
        if (ev.exdates.length < 1000) {
          for (const part of String(p.value).split(',').slice(0, 500)) {
            const d = parseDateValue(part, p.params);
            if (d) ev.exdates.push(d);
          }
        }
        break;
      case 'ATTENDEE': if (ev.attendees.length < 50) ev.attendees.push(personFrom(p)); break;
      case 'ORGANIZER': if (!ev.organizer) ev.organizer = personFrom(p); break;
      default: break;
    }
  }
  return ev;
}

// Parses a calendar file into appointment candidates.
//   timeZone: the workspace zone (bookings are wall-clock there)
//   now:      reference instant (tests pass a fixed one)
// Returns {
//   events: [{ uid, title, start, end, allDay, recurring, past, date,
//              startMin, endMin, attendees, organizerEmail, description, location }],
//   totals: { found, upcoming, past }, truncated, error? }
// `events` holds the upcoming ones (now → 12 months, at most MAX_OCCURRENCES,
// soonest first) followed by up to MAX_PAST_LISTED of the most recent past ones.
export function parseIcs(text, { timeZone, now = new Date() } = {}) {
  const empty = (error) => ({ events: [], totals: { found: 0, upcoming: 0, past: 0 }, truncated: false, ...(error ? { error } : {}) });
  if (typeof text !== 'string' || !text.trim()) return empty('The calendar file is empty.');
  if (Buffer.byteLength(text, 'utf8') > ICS_MAX_BYTES) return empty('The calendar file is too large (2 MB at most).');
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096)) && !/BEGIN:VEVENT/i.test(text.slice(0, 65536))) {
    return empty("That doesn't look like a calendar file.");
  }
  const wsTz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const nowMs = now.getTime();
  const toMs = nowMs + WINDOW_DAYS * DAY_MS;
  const todayIso = todayISOInZone(wsTz, now);

  const { vevents, truncated: tooMany } = collectVevents(unfoldLines(text));
  const events = vevents.map(readEvent).filter((e) => e.dtstart);
  const budget = { steps: STEP_BUDGET, exhausted: false };

  // Overrides of single occurrences (RECURRENCE-ID): the master skips that
  // occurrence, and the override (unless cancelled) stands on its own.
  const overrides = new Map(); // uid → Set(ms)
  for (const e of events) {
    if (e.recurrenceId && e.uid) {
      if (!overrides.has(e.uid)) overrides.set(e.uid, new Set());
      overrides.get(e.uid).add(dtToMs(e.recurrenceId, wsTz));
    }
  }

  // Candidates are kept light ({ e, ms, key, recurring }) and only the ones
  // returned are built into full items, so a file with thousands of events
  // costs little beyond the ones shown.
  const upcoming = [];
  const past = [];
  const usedKeys = new Set();
  let truncated = tooMany;

  const allDayDate = (e, ms) => {
    // Whole days after DTSTART (rounded: a DST change shifts the instant by an hour).
    const p = fromDayNum(dayNum(e.dtstart.y, e.dtstart.m, e.dtstart.d) + Math.round((ms - dtToMs(e.dtstart, wsTz)) / DAY_MS));
    return isoDate(p.y, p.m, p.d);
  };
  const isPastAt = (e, ms) => (e.dtstart.kind === 'date' ? allDayDate(e, ms) < todayIso : ms < nowMs);
  const localOf = (ms) => {
    const p = zonedParts(wsTz, new Date(ms));
    return { date: isoDate(p.y, p.m, p.d), min: p.minutes };
  };
  const build = ({ e, ms: startMs, recurring, key }) => {
    const allDay = e.dtstart.kind === 'date';
    let endMs;
    const firstMs = dtToMs(e.dtstart, wsTz);
    if (e.dtend && !e.recurrenceId) endMs = startMs + Math.max(0, dtToMs(e.dtend, wsTz) - firstMs);
    else if (e.dtend) endMs = dtToMs(e.dtend, wsTz);
    else if (e.duration) endMs = startMs + e.duration;
    else endMs = startMs + (allDay ? DAY_MS : 60 * 60_000);
    if (!(endMs > startMs)) endMs = startMs + (allDay ? DAY_MS : 60 * 60_000);
    let date, startMin, endMin;
    if (allDay) {
      date = allDayDate(e, startMs);
      startMin = 0; endMin = 24 * 60;
    } else {
      const s = localOf(startMs);
      const en = localOf(endMs);
      date = s.date; startMin = s.min;
      endMin = en.date === s.date ? en.min : 24 * 60;
      if (endMin <= startMin) endMin = Math.min(24 * 60, startMin + 60);
      if (endMin <= startMin) { startMin = 24 * 60 - 1; endMin = 24 * 60; }
    }
    return {
      uid: key,
      title: e.summary || '',
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      allDay, recurring, past: isPastAt(e, startMs),
      date, startMin, endMin,
      attendees: e.attendees.filter((a) => a.email || a.name).map((a) => ({ name: a.name, email: a.email, cutype: a.cutype })),
      organizerEmail: e.organizer?.email || null,
      description: e.description || '',
      location: e.location || '',
    };
  };
  const place = (cand) => {
    if (isPastAt(cand.e, cand.ms)) { past.push(cand); return; }
    if (cand.ms > toMs) return;
    if (upcoming.length >= MAX_CANDIDATES) { truncated = true; return; }
    upcoming.push(cand);
  };

  for (const e of events) {
    if (e.status === 'CANCELLED') continue;
    const startMs = dtToMs(e.dtstart, wsTz);
    const base = shortKey(e.uid || `nouid:${e.summary || ''}|${stamp(startMs)}`);

    if (e.recurrenceId) {
      const key = `${base}#${stamp(dtToMs(e.recurrenceId, wsTz))}`;
      if (usedKeys.has(key)) continue;
      usedKeys.add(key);
      place({ e, ms: startMs, recurring: true, key });
      continue;
    }

    if (e.rrule && !e.rrule.unsupported) {
      const room = MAX_CANDIDATES - upcoming.length;
      if (room <= 0 || budget.exhausted) { truncated = true; continue; }
      const exMs = new Set();
      const exDates = new Set();
      for (const x of e.exdates) {
        if (x.kind === 'date') exDates.add(isoDate(x.y, x.m, x.d));
        else exMs.add(dtToMs(x, wsTz));
      }
      // For all-day series, "upcoming" starts today in the workspace zone.
      const fromMs = e.dtstart.kind === 'date' ? zonedTimeToUtcMs(todayIso, 0, wsTz) - DAY_MS : nowMs;
      const occ = expandRule({
        rule: e.rrule, dtstart: e.dtstart, wsTz, fromMs, toMs,
        exMs, exDates, skipMs: overrides.get(e.uid) || new Set(), budget, cap: Math.min(MAX_OCCURRENCES, room),
      });
      let listed = 0;
      for (const ms of occ) {
        const key = `${base}#${stamp(ms)}`;
        if (usedKeys.has(key) || isPastAt(e, ms)) continue;
        usedKeys.add(key);
        place({ e, ms, recurring: true, key });
        listed++;
      }
      if (budget.exhausted) { truncated = true; continue; }
      // A series with nothing left in the window is shown once, as past.
      if (!listed && startMs < nowMs) {
        const key = `${base}#${stamp(startMs)}`;
        if (!usedKeys.has(key)) { usedKeys.add(key); past.push({ e, ms: startMs, recurring: true, key }); }
      }
      continue;
    }

    // Single event (or a rule we do not expand: only its first date).
    let key = base;
    if (usedKeys.has(key)) key = `${base}#${stamp(startMs)}`;
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    place({ e, ms: startMs, recurring: !!e.rrule, key });
  }

  upcoming.sort((a, b) => a.ms - b.ms);
  past.sort((a, b) => b.ms - a.ms);
  if (upcoming.length > MAX_OCCURRENCES) truncated = true;
  const up = upcoming.slice(0, MAX_OCCURRENCES).map(build);
  return {
    events: [...up, ...past.slice(0, MAX_PAST_LISTED).map(build)],
    totals: { found: up.length + past.length, upcoming: up.length, past: past.length },
    truncated,
  };
}

// ── Guessing the client and the service ──────────────────────────────

const NOT_A_NAME = new Set(`meeting call lunch dinner breakfast coffee appointment appt busy block blocked hold
holiday vacation off gym dentist doctor review sync standup team office birthday flight travel session class
consultation consult booking reminder event personal private work school pickup drop out free tentative focus
time day week the a an my new follow up intro interview webinar workshop training admin closed open available
unavailable lesson trip party deadline payment zoom phone video online virtual
haircut cut color colour massage facial nails manicure pedicure wax waxing trim blowout shoot photo photos
therapy checkin check-in coaching tutoring tutor practice rehearsal meetup`.split(/\s+/).filter(Boolean));

const NAME_WORD = /^[\p{L}][\p{L}\p{M}'’.-]{0,30}$/u;

function looksLikeName(s, { minWords = 1 } = {}) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60) return false;
  const words = t.split(' ');
  if (words.length < minWords || words.length > 4) return false;
  for (const w of words) {
    if (!NAME_WORD.test(w)) return false;
    if (NOT_A_NAME.has(w.toLowerCase().replace(/[.'’]/g, ''))) return false;
  }
  return true;
}

function matchesService(s, services) {
  const t = String(s || '').trim().toLowerCase();
  return !!t && services.some((sv) => sv.lname === t || (sv.lname.length >= 3 && t.includes(sv.lname)));
}

// Client name from an event title. Patterns: "Haircut - Jane Doe",
// "Jane Doe (Haircut)", "Jane Doe: Haircut", "Haircut with Jane Doe", or a
// title that is only a person's name. Returns a name or null; never invents.
export function nameFromTitle(title, services = []) {
  const svc = services.map((s) => ({ ...s, lname: String(s.name || '').trim().toLowerCase() })).filter((s) => s.lname);
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t) return null;
  const pick = (a, b) => {
    const aName = looksLikeName(a) && !matchesService(a, svc);
    const bName = looksLikeName(b) && !matchesService(b, svc);
    if (aName && !bName) return a.trim();
    if (bName && !aName) return b.trim();
    if (!aName && !bName) return null;
    // Both could be names: a side that names a service is not the client;
    // otherwise prefer the side with two or more words, then the first.
    if (matchesService(a, svc)) return b.trim();
    if (matchesService(b, svc)) return a.trim();
    const aw = a.trim().split(' ').length, bw = b.trim().split(' ').length;
    if (aw >= 2 && bw < 2) return a.trim();
    if (bw >= 2 && aw < 2) return b.trim();
    return a.trim();
  };
  // "Jane Doe (Haircut)" / "Haircut (Jane Doe)"
  const open = t.indexOf('(');
  if (open > 0 && t.endsWith(')')) {
    const r = pick(t.slice(0, open), t.slice(open + 1, -1));
    if (r) return r;
  }
  for (const sep of [' - ', ' – ', ' — ', ' | ', ': ']) {
    const i = t.indexOf(sep);
    if (i > 0) {
      const r = pick(t.slice(0, i), t.slice(i + sep.length));
      if (r) return r;
    }
  }
  const w = t.toLowerCase().indexOf(' with ');
  if (w > 0) {
    const right = t.slice(w + 6);
    if (looksLikeName(right) && !matchesService(right, svc)) return right.trim();
  }
  if (looksLikeName(t, { minWords: 2 }) && !matchesService(t, svc)) return t;
  return null;
}

// Service whose name appears in the title (case-insensitive), longest first.
export function guessService(title, services = []) {
  const t = String(title || '').toLowerCase();
  if (!t) return null;
  let best = null;
  for (const s of services) {
    const n = String(s.name || '').trim().toLowerCase();
    if (n.length < 3 || !t.includes(n)) continue;
    if (!best || n.length > best.name.length) best = { id: s.id, name: String(s.name).trim() };
  }
  return best ? { serviceId: best.id, serviceName: best.name } : null;
}

// The client of an event: an attendee who is not the organizer or the owner
// (and not a room or resource), else a name read from the title.
// ownerEmails: lower-cased addresses that belong to the owner.
export function guessClient({ title, attendees = [], organizerEmail = null, ownerEmails = [], services = [] }) {
  const own = new Set([...(ownerEmails || []), organizerEmail].filter(Boolean).map((e) => String(e).toLowerCase()));
  const guest = (attendees || []).find((a) => (a.email || a.name)
    && !(a.email && own.has(a.email))
    && !['ROOM', 'RESOURCE'].includes(a.cutype || ''));
  const fromTitle = nameFromTitle(title, services);
  if (guest) {
    const name = guest.name && looksLikeName(guest.name) ? guest.name : (fromTitle || guest.name || null);
    return { clientName: name ? String(name).slice(0, 120) : null, clientEmail: guest.email || null };
  }
  return { clientName: fromTitle, clientEmail: null };
}
