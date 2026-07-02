// Timezone helpers (server). Ivy OS stores booking times as floating wall-clock
// (a DATE + minutes-from-midnight) with the intended zone living in
// calendar_settings.timezone. These convert between that wall-clock model and
// absolute instants so "is this slot in the past" / "what is today" can be
// answered in the WORKSPACE's zone instead of the server's UTC.
//
// Dependency-free: uses the standard Intl offset round-trip (no date-fns/luxon).
// A twin copy lives at src/lib/tz.js for the browser (the two build roots can't
// import across each other); keep the two in sync — tests/tz.test.mjs covers the
// server one and the same cases should hold for both.

// Offset (ms) of `tz` from UTC at the given absolute instant. Positive east of
// UTC. Works by formatting the instant AS IF in `tz`, reading the wall-clock
// fields back, and diffing against the same fields interpreted as UTC.
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  // Intl emits hour "24" at midnight in some engines — normalize to 0.
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asUTC - utcMs;
}

// Validate/normalize an IANA name; returns null when unusable so callers fall
// back to UTC (never throw on bad owner input).
export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

// Absolute epoch-ms of a wall-clock time (dateISO 'YYYY-MM-DD' + minutes from
// midnight) interpreted in `tz`. Two-pass so DST transitions resolve correctly.
// Falls back to treating the wall-clock as UTC when `tz` is missing/invalid.
export function zonedTimeToUtcMs(dateISO, minutes, tz) {
  const [y, m, d] = String(dateISO).slice(0, 10).split('-').map(Number);
  const h = Math.floor(minutes / 60);
  const mn = ((minutes % 60) + 60) % 60;
  const naiveUtc = Date.UTC(y, m - 1, d, h, mn);
  if (!isValidTimeZone(tz)) return naiveUtc;
  const off1 = tzOffsetMs(naiveUtc, tz);
  let utc = naiveUtc - off1;
  const off2 = tzOffsetMs(utc, tz);
  if (off2 !== off1) utc = naiveUtc - off2; // DST edge: re-correct once
  return utc;
}

// Wall-clock parts of an instant in `tz`: { y, m, d, weekday(0=Sun), minutes }.
// weekday/minutes make it easy to mirror Date.getDay()/getHours()*60 semantics
// but in the workspace zone.
export function zonedParts(tz, date = new Date()) {
  const useTz = isValidTimeZone(tz) ? tz : 'UTC';
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: useTz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    weekday: WD[p.weekday] ?? 0,
    minutes: hour * 60 + Number(p.minute),
  };
}

// 'YYYY-MM-DD' for "today" in `tz`.
export function todayISOInZone(tz, date = new Date()) {
  const { y, m, d } = zonedParts(tz, date);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
