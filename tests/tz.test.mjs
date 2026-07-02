// Unit tests for api/_lib/tz.js — the wall-clock↔UTC conversion that lets the
// app reason about "today"/"is this slot past" in a workspace's timezone.
// Pure functions, no DB. (The browser twin src/lib/tz.js mirrors this logic.)
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/tz.test.mjs

import { zonedTimeToUtcMs, zonedParts, todayISOInZone, isValidTimeZone } from '../api/_lib/tz.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Helper: what UTC instant does a wall-clock produce, as an ISO string?
const iso = (ms) => new Date(ms).toISOString();

console.log('\n[1] validation + UTC fallback');
assert(isValidTimeZone('America/New_York') === true, 'valid IANA name accepted');
assert(isValidTimeZone('Not/AZone') === false, 'bogus name rejected');
assert(isValidTimeZone(null) === false, 'null rejected');
// Null/invalid tz → treat wall-clock as UTC.
assert(iso(zonedTimeToUtcMs('2026-06-15', 9 * 60, null)) === '2026-06-15T09:00:00.000Z',
  'null tz → wall-clock interpreted as UTC');

console.log('\n[2] fixed offsets (no DST) — Asia/Kolkata is UTC+5:30 year-round');
// 09:00 in Kolkata (UTC+5:30) == 03:30 UTC.
assert(iso(zonedTimeToUtcMs('2026-06-15', 9 * 60, 'Asia/Kolkata')) === '2026-06-15T03:30:00.000Z',
  '09:00 Kolkata → 03:30Z');
// Midnight in Kolkata == previous day 18:30 UTC (crosses the UTC date boundary).
assert(iso(zonedTimeToUtcMs('2026-06-15', 0, 'Asia/Kolkata')) === '2026-06-14T18:30:00.000Z',
  'midnight Kolkata → prior-day 18:30Z (date boundary)');

console.log('\n[3] negative offset — America/New_York');
// Summer (EDT, UTC-4): 14:00 EDT == 18:00 UTC.
assert(iso(zonedTimeToUtcMs('2026-07-01', 14 * 60, 'America/New_York')) === '2026-07-01T18:00:00.000Z',
  '14:00 EDT → 18:00Z (summer, UTC-4)');
// Winter (EST, UTC-5): 14:00 EST == 19:00 UTC.
assert(iso(zonedTimeToUtcMs('2026-01-15', 14 * 60, 'America/New_York')) === '2026-01-15T19:00:00.000Z',
  '14:00 EST → 19:00Z (winter, UTC-5)');

console.log('\n[4] DST transition edge — US spring-forward 2026-03-08 02:00→03:00');
// The day before and after should use the correct offsets on both sides.
assert(iso(zonedTimeToUtcMs('2026-03-07', 12 * 60, 'America/New_York')) === '2026-03-07T17:00:00.000Z',
  '2026-03-07 noon EST → 17:00Z (still UTC-5)');
assert(iso(zonedTimeToUtcMs('2026-03-09', 12 * 60, 'America/New_York')) === '2026-03-09T16:00:00.000Z',
  '2026-03-09 noon EDT → 16:00Z (now UTC-4)');

console.log('\n[5] zonedParts + todayISOInZone at a known instant');
// 2026-06-15T02:00:00Z is 2026-06-14 22:00 in New York (weekday Sunday=0).
const at = new Date('2026-06-15T02:00:00Z');
const p = zonedParts('America/New_York', at);
assert(p.y === 2026 && p.m === 6 && p.d === 14, `NY parts date is 2026-06-14 (got ${p.y}-${p.m}-${p.d})`);
assert(p.minutes === 22 * 60, `NY minutes = 22:00 (got ${p.minutes})`);
assert(p.weekday === 0, `NY weekday Sunday=0 (got ${p.weekday})`);
assert(todayISOInZone('America/New_York', at) === '2026-06-14', 'todayISOInZone NY = 2026-06-14');
// Same instant in Kolkata is already 2026-06-15 07:30.
assert(todayISOInZone('Asia/Kolkata', at) === '2026-06-15', 'todayISOInZone Kolkata = 2026-06-15');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
