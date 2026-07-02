// A curated list of common IANA timezones for the owner's booking-timezone
// picker. Not exhaustive (there are ~350) — just the ones a solo service
// business is realistically in, grouped by region. timezoneOptions() always
// folds in the owner's current value + the browser-detected zone so nothing is
// unselectable even if it's outside the curated set.

export const COMMON_TIMEZONES = [
  // North America
  { value: 'America/New_York',    label: 'Eastern Time — New York' },
  { value: 'America/Chicago',     label: 'Central Time — Chicago' },
  { value: 'America/Denver',      label: 'Mountain Time — Denver' },
  { value: 'America/Phoenix',     label: 'Mountain (no DST) — Phoenix' },
  { value: 'America/Los_Angeles', label: 'Pacific Time — Los Angeles' },
  { value: 'America/Anchorage',   label: 'Alaska Time — Anchorage' },
  { value: 'Pacific/Honolulu',    label: 'Hawaii Time — Honolulu' },
  { value: 'America/Toronto',     label: 'Eastern — Toronto' },
  { value: 'America/Vancouver',   label: 'Pacific — Vancouver' },
  { value: 'America/Mexico_City', label: 'Central — Mexico City' },
  // South America
  { value: 'America/Sao_Paulo',   label: 'Brazil — São Paulo' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Argentina — Buenos Aires' },
  // Europe / Africa
  { value: 'Europe/London',       label: 'UK — London' },
  { value: 'Europe/Dublin',       label: 'Ireland — Dublin' },
  { value: 'Europe/Paris',        label: 'Central Europe — Paris' },
  { value: 'Europe/Berlin',       label: 'Central Europe — Berlin' },
  { value: 'Europe/Madrid',       label: 'Central Europe — Madrid' },
  { value: 'Europe/Athens',       label: 'Eastern Europe — Athens' },
  { value: 'Africa/Johannesburg', label: 'South Africa — Johannesburg' },
  { value: 'Africa/Lagos',        label: 'West Africa — Lagos' },
  // Middle East / Asia
  { value: 'Asia/Dubai',          label: 'Gulf — Dubai' },
  { value: 'Asia/Kolkata',        label: 'India — Kolkata' },
  { value: 'Asia/Bangkok',        label: 'Thailand — Bangkok' },
  { value: 'Asia/Singapore',      label: 'Singapore' },
  { value: 'Asia/Hong_Kong',      label: 'Hong Kong' },
  { value: 'Asia/Tokyo',          label: 'Japan — Tokyo' },
  // Oceania
  { value: 'Australia/Sydney',    label: 'Australia — Sydney' },
  { value: 'Australia/Perth',     label: 'Australia — Perth' },
  { value: 'Pacific/Auckland',    label: 'New Zealand — Auckland' },
  { value: 'UTC',                 label: 'UTC' },
];

// The browser's best guess at the user's zone (used as the onboarding default).
export function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; }
  catch { return null; }
}

// A friendly label for a stored IANA zone, e.g. "Eastern Time · New York".
// Used on the public booking page so clients know which zone the times are in.
// Returns null for an empty/invalid tz so callers fall back to legacy copy.
export function tzDisplay(tz, date = new Date()) {
  if (!tz) return null;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value;
    const city = tz.split('/').pop().replace(/_/g, ' ');
    return name ? `${name} · ${city}` : city;
  } catch { return null; }
}

// Build the <option> list, guaranteeing `current` (and the browser zone) appear
// even when they aren't in the curated set — otherwise a controlled <select>
// would silently drop the owner's saved value.
export function timezoneOptions(current) {
  const opts = COMMON_TIMEZONES.slice();
  const have = new Set(opts.map((o) => o.value));
  for (const tz of [current, browserTimeZone()]) {
    if (tz && !have.has(tz)) { opts.unshift({ value: tz, label: tz }); have.add(tz); }
  }
  return opts;
}
