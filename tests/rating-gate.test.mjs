// App Store rating prompt: the pure gate (src/lib/ratingGate.js). Who is
// asked, after which win, and how often.
// Run: node ./tests/rating-gate.test.mjs
import { ratingGate, isWinMoment, askedRecently, lastAsk, RATING_INTERVAL_DAYS, WIN_KINDS } from '../src/lib/ratingGate.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const owner = (over = {}) => ({ role: 'owner', pathname: '/finance', now: NOW, ...over });

console.log('\n[1] wins are exact milestones');
assert(RATING_INTERVAL_DAYS === 120, 'interval is 120 days');
assert(WIN_KINDS.length === 4, 'four win kinds');
assert(isWinMoment('invoice_paid', { invoice_paid: 1 }), 'first paid invoice');
assert(!isWinMoment('invoice_paid', { invoice_paid: 2 }), 'second paid invoice is not a milestone');
assert(!isWinMoment('invoice_paid', {}), 'no count: no win');
assert(isWinMoment('booking_completed', { booking_completed: 10 }), '10th completed booking');
assert(!isWinMoment('booking_completed', { booking_completed: 9 }), '9th completed booking: not yet');
assert(!isWinMoment('booking_completed', { booking_completed: 11 }), '11th completed booking: already passed');
assert(isWinMoment('website_published', { website_published: 1 }), 'first website publish');
assert(isWinMoment('partner_cleared', { partner_cleared: 3 }, { partnerOnAt: ago(8), now: NOW }), 'partner on 8 days, 3 cleared');
assert(!isWinMoment('partner_cleared', { partner_cleared: 3 }, { partnerOnAt: ago(3), now: NOW }), 'partner on 3 days: not a week yet');
assert(!isWinMoment('partner_cleared', { partner_cleared: 3 }, { now: NOW }), 'partner never turned on: no win');
assert(!isWinMoment('partner_cleared', { partner_cleared: 2 }, { partnerOnAt: ago(30), now: NOW }), 'only 2 cleared: not yet');
assert(!isWinMoment('made_up', { made_up: 1 }), 'unknown kind: never');

console.log('\n[2] who is asked');
const g = (over) => ratingGate(owner({ kind: 'invoice_paid', counts: { invoice_paid: 1 }, ...over }));
assert(g().ask === true && g().reason === 'win', 'owner at a win: asked');
assert(g({ role: 'client' }).reason === 'not-owner', 'client: never');
assert(g({ role: 'helper' }).reason === 'not-owner', 'helper: never');
assert(g({ role: 'admin-view' }).reason === 'not-owner', 'admin viewing as the owner: never');
assert(g({ role: null }).reason === 'not-owner', 'unknown role: never');
assert(g({ pathname: '/onboarding' }).reason === 'onboarding', 'during onboarding: never');
assert(g({ pathname: '/onboarding/step-2' }).reason === 'onboarding', 'onboarding sub-step: never');
assert(g({ pathname: '/dashboard' }).ask, 'dashboard path: fine');
assert(g({ blocked: true }).reason === 'blocked', 'paywall or crash screen: never');
assert(g({ counts: { invoice_paid: 2 } }).reason === 'not-a-win', 'not a milestone: not asked');

console.log('\n[3] at most once per 120 days, across phone and server');
assert(g({ lastAskedAt: ago(10) }).reason === 'asked-recently', 'phone asked 10 days ago: wait');
assert(g({ lastAskedAt: ago(119) }).reason === 'asked-recently', 'phone asked 119 days ago: wait');
assert(g({ lastAskedAt: ago(120) }).ask, 'phone asked 120 days ago: may ask');
assert(g({ lastAskedAt: ago(400) }).ask, 'phone asked long ago: may ask');
assert(g({ serverPromptedAt: ago(30) }).reason === 'asked-recently', 'fresh install, server says 30 days ago: wait');
assert(g({ lastAskedAt: ago(200), serverPromptedAt: ago(30) }).reason === 'asked-recently', 'newest of the two dates wins (server)');
assert(g({ lastAskedAt: ago(30), serverPromptedAt: ago(200) }).reason === 'asked-recently', 'newest of the two dates wins (phone)');
assert(g({ lastAskedAt: ago(200), serverPromptedAt: ago(130) }).ask, 'both older than 120 days: may ask');
assert(g({ lastAskedAt: 'garbage' }).ask, 'unreadable date is treated as never asked');
assert(lastAsk(null, null) === null, 'never asked anywhere');
assert(lastAsk(ago(5), null) === Date.parse(ago(5)), 'phone only');
assert(!askedRecently({ now: NOW }), 'never asked: not recent');
assert(askedRecently({ lastAskedAt: ago(1), now: NOW }), 'yesterday: recent');

console.log('\n[4] a win asks exactly once');
// Simulate the runtime: counts grow by one per Complete; the ask stamps the date.
let asked = 0; let lastAskedAt = null; const counts = {};
for (let i = 1; i <= 25; i++) {
  counts.booking_completed = i;
  const r = ratingGate(owner({ kind: 'booking_completed', counts, lastAskedAt }));
  if (r.ask) { asked++; lastAskedAt = new Date(NOW).toISOString(); }
}
assert(asked === 1, '25 completions: asked once (on the 10th)');
// A second win kind right after the first is held by the interval.
counts.invoice_paid = 1;
assert(ratingGate(owner({ kind: 'invoice_paid', counts, lastAskedAt })).reason === 'asked-recently', 'first paid invoice the same day: not asked again');
assert(ratingGate(owner({ kind: 'invoice_paid', counts, lastAskedAt, now: NOW + 121 * DAY })).ask, 'the same win 121 days later: asked');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
