// Timezone helpers (browser twin of api/_lib/tz.js). Keep the two in sync — the
// client build root and the serverless api/ root can't import across each other,
// so the ~30 lines of Intl offset math are duplicated on purpose. See the server
// copy for the full rationale; tests/tz.test.mjs exercises the shared behavior.
//
// Used by src/features/calendar/utils.js slotsForDate so "past / too soon"
// decisions compare against "now in the WORKSPACE timezone" instead of the
// viewer's browser zone (which is what caused the client/server slot mismatch).

function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asUTC - utcMs;
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

// Epoch-ms of wall-clock (dateISO + minutes) interpreted in `tz`. Falls back to
// treating it as the viewer's local time when `tz` is missing/invalid, matching
// the pre-timezone behavior so nothing regresses for owners who never set one.
export function zonedTimeToUtcMs(dateISO, minutes, tz) {
  const [y, m, d] = String(dateISO).slice(0, 10).split('-').map(Number);
  const h = Math.floor(minutes / 60);
  const mn = ((minutes % 60) + 60) % 60;
  if (!isValidTimeZone(tz)) {
    return new Date(y, m - 1, d, h, mn, 0, 0).getTime(); // local, legacy behavior
  }
  const naiveUtc = Date.UTC(y, m - 1, d, h, mn);
  const off1 = tzOffsetMs(naiveUtc, tz);
  let utc = naiveUtc - off1;
  const off2 = tzOffsetMs(utc, tz);
  if (off2 !== off1) utc = naiveUtc - off2;
  return utc;
}

export function zonedParts(tz, date = new Date()) {
  const useTz = isValidTimeZone(tz) ? tz : undefined; // undefined = browser local
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

// Midnight (start of day) of dateISO in `tz`, as epoch-ms.
export function zonedStartOfDayMs(dateISO, tz) {
  return zonedTimeToUtcMs(dateISO, 0, tz);
}
