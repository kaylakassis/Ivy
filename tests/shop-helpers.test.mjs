// Pure helpers behind the public shop page (src/features/shops/shopHelpers.js).
// No database.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/shop-helpers.test.mjs
import {
  groupServices, sectionServices, firstAvailable, nextForMemberAny, nextAcrossShop, weekSlots, openStatus, hoursLines, shopRating,
  searchTeam, weekdayFromText, nextLabel, relativeDay,
} from '../src/features/shops/shopHelpers.js';
import { addDays, fmtDateISO } from '../src/features/calendar/utils.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const ALL_DAY = { 0: [{ start: 540, end: 1020 }], 1: [{ start: 540, end: 1020 }], 2: [{ start: 540, end: 1020 }], 3: [{ start: 540, end: 1020 }], 4: [{ start: 540, end: 1020 }], 5: [{ start: 540, end: 1020 }], 6: [{ start: 540, end: 1020 }] };
const settings = (over = {}) => ({ timezone: 'UTC', availability: ALL_DAY, slotMinutes: 30, slotFitService: false, bufferMinutes: 0, minNoticeHours: 0, maxAdvanceDays: 60, ...over });
const svc = (id, name, price, dur = 60, extra = {}) => ({ id, name, price, durationMinutes: dur, capacity: 1, ...extra });
const member = (id, firstName, services, over = {}) => ({ id, firstName, businessName: `${firstName} Co`, settings: settings(over.settings), services, blocks: over.blocks || [], bookings: over.bookings || [], reviews: over.reviews || { count: 0, avg: null, recent: [] } });

// Tomorrow at 00:00 UTC keeps every slot in the future whatever the clock says.
const tomorrow = addDays(new Date(), 1);
tomorrow.setHours(0, 0, 0, 0);
const tISO = fmtDateISO(tomorrow);

console.log('\n[1] Service grouping');
{
  const A = member('a', 'Ana', [svc('s1', 'Fade', 40), svc('s2', 'Beard trim', 20, 30)]);
  const B = member('b', 'Ben', [svc('s3', 'fade ', 35), svc('s4', 'Color', 120, 120)]);
  const g = groupServices([A, B]);
  assert(g.map((x) => x.name).join(',') === 'Beard trim,Color,Fade', 'one row per name, sorted');
  const fade = g.find((x) => x.key === 'fade');
  assert(fade.members.length === 2 && fade.fromPrice === 35 && fade.maxPrice === 40, 'same name merges with "from" price');
  assert(fade.entries.length === 2 && fade.minDuration === 60, 'entries carry each pro\'s service');
  const sections = sectionServices(g);
  assert(sections.length === 1 && sections[0].title === null, 'one category → one unnamed section');
  const C = member('c', 'Cat', [svc('s5', 'Massage', 90)], { settings: { category: 'Wellness' } });
  const D = member('d', 'Dee', [svc('s6', 'Fade', 30)], { settings: { category: 'Beauty' } });
  const s2 = sectionServices(groupServices([C, D]));
  assert(s2.map((s) => s.title).join(',') === 'Beauty,Wellness', 'two categories → named sections');
}

console.log('\n[2] First available across the shop');
{
  // Ana is blocked until 3pm tomorrow; Ben is free from 9am. Ben wins.
  const A = member('a', 'Ana', [svc('s1', 'Fade', 40)], { blocks: [{ date: tISO, startMin: 0, endMin: 900, label: 'Busy' }] });
  const B = member('b', 'Ben', [svc('s3', 'Fade', 35)]);
  const g = groupServices([A, B]).find((x) => x.key === 'fade');
  const fa = firstAvailable(g, [A, B], tomorrow);
  assert(fa && fa.member.id === 'b' && fa.dateISO === tISO && fa.slot.start === 540, 'soonest slot is Ben at 9:00');
  // Ben also booked solid all day → Ana at 3pm.
  const B2 = { ...B, bookings: [{ id: 'x', serviceId: 'other', date: tISO, startMin: 540, endMin: 1020 }] };
  const fa2 = firstAvailable(g, [A, B2], tomorrow);
  assert(fa2 && fa2.member.id === 'a' && fa2.slot.start === 900, 'then Ana at 3:00 pm');
  // Time zones: Ana in New York (9:00 local = 14:00Z), Ben in London (9:00 local = 09:00Z): Ben is sooner.
  const A3 = member('a', 'Ana', [svc('s1', 'Fade', 40)], { settings: { timezone: 'America/New_York' } });
  const B3 = member('b', 'Ben', [svc('s3', 'Fade', 35)], { settings: { timezone: 'Europe/London' } });
  const fa3 = firstAvailable(g, [A3, B3], tomorrow);
  assert(fa3 && fa3.member.id === 'b', 'compares real instants across time zones');
  const nx = nextForMemberAny(A, tomorrow);
  assert(nx && nx.slot.start === 900, 'next for a pro across all their services');
  const w = weekSlots(g, [A, B], tomorrow, { days: 2, max: 5 });
  assert(w.length === 5 && w.every((s, i) => i === 0 || s.ms >= w[i - 1].ms) && w[0].member.id === 'b', 'week list soonest first, capped');
  assert(firstAvailable(g, [], tomorrow) === null, 'no members → null');
  const na = nextAcrossShop([A3, B3], tomorrow);
  assert(na && na.member.id === 'b', 'soonest opening on the team compares real instants across pros');
  assert(nextAcrossShop([], tomorrow) === null, 'soonest opening: empty team → null');
}

console.log('\n[3] Open status and hours lines');
{
  const hours = { 1: [{ start: 540, end: 1140 }], 2: [{ start: 540, end: 1140 }], 0: [], 3: [], 4: [], 5: [], 6: [] };
  // A Monday 10:00 UTC.
  const mon = new Date(Date.UTC(2026, 0, 5, 10, 0)); // 2026-01-05 is a Monday
  assert(openStatus(hours, 'UTC', mon).label === 'Open until 7:00 pm', 'open now → "Open until"');
  const monEarly = new Date(Date.UTC(2026, 0, 5, 7, 0));
  assert(openStatus(hours, 'UTC', monEarly).label === 'Opens at 9:00 am', 'before opening → "Opens at"');
  const tue = new Date(Date.UTC(2026, 0, 6, 20, 0));
  assert(openStatus(hours, 'UTC', tue).label === 'Closed now. Opens Monday at 9:00 am', 'closed days ahead → next open day');
  const sun = new Date(Date.UTC(2026, 0, 4, 12, 0));
  assert(openStatus(hours, 'UTC', sun).label === 'Closed now. Opens tomorrow at 9:00 am', 'closed the day before → tomorrow');
  assert(openStatus({}, 'UTC', mon).label === '', 'no hours → nothing');
  const lines = hoursLines(hours);
  assert(lines[0].day === 'Monday' && lines[0].text === '9:00 am to 7:00 pm' && lines[6].day === 'Sunday' && lines[6].text === 'Closed', 'Monday first, closed days say Closed');
}

console.log('\n[4] Honest rating');
{
  const r = shopRating([
    { reviews: { count: 2, avg: 5 } }, { reviews: { count: 1, avg: 3 } }, { reviews: { count: 0, avg: null } },
  ]);
  assert(r.count === 3 && r.avg === 4.33, 'count-weighted mean (13/3 = 4.33), not the mean of means (4)');
  assert(shopRating([]).avg === null && shopRating([]).count === 0, 'no reviews → null');
}

console.log('\n[5] Guided team search');
{
  const WEEKDAYS_ONLY = { 1: [{ start: 540, end: 1020 }], 2: [{ start: 540, end: 1020 }], 3: [{ start: 540, end: 1020 }], 4: [{ start: 540, end: 1020 }], 5: [{ start: 540, end: 1020 }], 0: [], 6: [] };
  const A = member('a', 'Ana', [svc('s1', 'Skin fade', 40), svc('s2', 'Beard trim', 20)], { settings: { availability: WEEKDAYS_ONLY } });
  const B = member('b', 'Ben', [svc('s3', 'Fade', 35)]);
  assert(weekdayFromText('Who does fades on Saturdays?') === 6, 'reads the weekday');
  const r = searchTeam([A, B], 'Who does fades on Saturdays?');
  assert(r.weekday === 6 && r.matches.length === 1 && r.matches[0].member.id === 'b', 'Ben does fades and opens Saturdays; Ana is closed');
  const r2 = searchTeam([A, B], 'fade');
  assert(r2.matches.length === 2, 'no weekday → both pros who do fades');
  const r3 = searchTeam([A, B], 'beard');
  assert(r3.matches.length === 1 && r3.matches[0].services[0].name === 'Beard trim', 'matches the right service');
  const r4 = searchTeam([A, B], '', 0);
  assert(r4.matches.length === 1 && r4.matches[0].member.id === 'b', 'weekday chip alone narrows to who opens that day');
  assert(searchTeam([A, B], 'tattoo').matches.length === 0, 'no match → empty');
}

console.log('\n[6] Labels');
{
  const now = new Date(Date.UTC(2026, 5, 10, 12, 0));
  assert(relativeDay('2026-06-10', 'UTC', now) === 'today' && relativeDay('2026-06-11', 'UTC', now) === 'tomorrow', 'today / tomorrow in the shop zone');
  assert(nextLabel({ dateISO: '2026-06-10', slot: { start: 930 } }, 'UTC', now) === 'Next: today 3:30 pm', 'Next: today 3:30 pm');
  assert(nextLabel(null) === 'No open times right now', 'no next → plain words');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
