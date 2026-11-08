// Pure helpers behind the 1.0.5 public booking page
// (src/features/calendar/publicBookingHelpers.js) plus the server-side
// contact-phone and Outlook link builders. No database.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/public-booking-helpers.test.mjs
import {
  groupSlotsByPeriod, dayStatus, waitlistSeed, buildDays, findNextAvailable, stripLimit,
  zoneTimes, dualTimeLabel, nextAvailableLabel, resolveServiceParam, listedServices, filterServices,
  policyLines, fmtDuration, fmtPrice, mapsUrl, telHref,
  readRemembered, writeRemembered, forgetRemembered, REMEMBER_KEY,
} from '../src/features/calendar/publicBookingHelpers.js';
import { addDays, fmtDateISO, startOfToday } from '../src/features/calendar/utils.js';
import { publicContactPhone } from '../api/_lib/calendar.js';
import { buildOutlookCalendarUrl, buildGoogleCalendarUrl } from '../api/_lib/ical.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const slot = (start, extra = {}) => ({ start, end: start + 30, available: true, reason: null, ...extra });

console.log('\n[1] Morning / Afternoon / Evening grouping');
{
  const g = groupSlotsByPeriod([slot(17 * 60), slot(9 * 60), slot(12 * 60), slot(11 * 60 + 30), slot(16 * 60 + 30), slot(20 * 60)]);
  assert(g.map((x) => x.label).join(',') === 'Morning,Afternoon,Evening', 'three periods in day order');
  assert(g[0].slots.map((s) => s.start).join(',') === '540,690', 'morning sorted, ends before noon');
  assert(g[1].slots.map((s) => s.start).join(',') === '720,990', 'noon starts the afternoon, 4:30 pm stays in it');
  assert(g[2].slots.map((s) => s.start).join(',') === '1020,1200', '5 pm starts the evening');
  assert(groupSlotsByPeriod([slot(14 * 60)]).length === 1, 'empty periods are left out');
  const many = Array.from({ length: 30 }, (_, i) => slot(8 * 60 + i * 30));
  assert(groupSlotsByPeriod(many).reduce((n, x) => n + x.slots.length, 0) === 30, 'every slot is kept (no "+N more")');
  assert(groupSlotsByPeriod(null).length === 0 && groupSlotsByPeriod([null, {}]).length === 0, 'bad input is safe');
}

console.log('\n[2] Day status and waitlist seed');
{
  assert(dayStatus([]) === 'closed', 'no slots = closed');
  assert(dayStatus([slot(540, { available: false, reason: 'Booked' }), slot(570)]) === 'open', 'any free slot = open');
  assert(dayStatus([slot(540, { available: false, reason: 'Booked' })]) === 'full', 'all booked = full');
  assert(dayStatus([slot(540, { available: false, reason: null })]) === 'full', 'full class (capacity) = full');
  assert(dayStatus([slot(540, { available: false, reason: 'Too soon' }), slot(570, { available: false, reason: 'Past' })]) === 'none', 'only too-soon / past = no times (not a waitlist)');
  assert(dayStatus([slot(540, { available: false, reason: 'Blocked' })]) === 'closed', 'owner blocked the day off = closed (no waitlist)');
  const seed = waitlistSeed([slot(540, { available: false, reason: 'Past' }), slot(570, { available: false, reason: 'Blocked' }), slot(600, { available: false, reason: 'Booked' })]);
  assert(seed && seed.start === 600, 'waitlist seed skips past and blocked slots');
  assert(waitlistSeed([slot(540, { available: false, reason: 'Too soon' })]) === null, 'no seed when nothing can open up');
}

console.log('\n[3] Days and next available (injected slot function)');
{
  const from = new Date(2026, 10, 2); // Mon Nov 2 2026, local
  const fake = (_cal, date) => {
    const d = date.getDate();
    if (d === 2) return [];                                                   // closed
    if (d === 3) return [slot(540, { available: false, reason: 'Booked' })];   // full
    if (d === 4) return [slot(600, { available: true }), slot(540, { available: true })];
    return [slot(540)];
  };
  const days = buildDays({}, { id: 's' }, from, 5, fake);
  assert(days.length === 5 && days[0].dateISO === '2026-11-02', 'buildDays covers the requested count from the start date');
  assert(days.map((d) => d.status).join(',') === 'closed,full,open,open,open', 'statuses per day');
  assert(days[2].slots.length === 2 && days[1].slots.length === 0, 'slots holds only bookable times');
  const next = findNextAvailable({}, { id: 's' }, from, 30, fake);
  assert(next && next.dateISO === '2026-11-04' && next.slot.start === 540 && next.index === 2, 'next available = first open day, earliest time');
  assert(nextAvailableLabel(next) === 'Wed, Nov 4 at 9:00 am', `label reads "Wed, Nov 4 at 9:00 am" (${nextAvailableLabel(next)})`);
  assert(findNextAvailable({}, { id: 's' }, from, 2, fake) === null, 'nothing within the window = null');
  assert(stripLimit({ maxAdvanceDays: 60 }) === 61 && stripLimit({ maxAdvanceDays: 0 }) === 180 && stripLimit({ maxAdvanceDays: 400 }) === 180, 'strip limited by horizon, capped at 180 days');
}

console.log('\n[4] Real slot engine: next available respects notice, bookings and closed days');
{
  const today = startOfToday();
  const allWeek = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 540, end: 660 }]]));
  const tomorrow = addDays(today, 1);
  const cal = {
    settings: { availability: allWeek, slotMinutes: 60, minNoticeHours: 0, maxAdvanceDays: 30, timezone: null },
    blocks: [],
    bookings: [
      { id: 'b1', serviceId: 'x', date: fmtDateISO(tomorrow), startMin: 540, endMin: 600 },
    ],
  };
  const svc = { id: 'x', durationMinutes: 60, capacity: 1 };
  const next = findNextAvailable(cal, svc, tomorrow, 10);
  assert(next && next.dateISO === fmtDateISO(tomorrow) && next.slot.start === 600, 'skips the booked 9:00 and lands on 10:00 tomorrow');
  const fullCal = { ...cal, bookings: [...cal.bookings, { id: 'b2', serviceId: 'x', date: fmtDateISO(tomorrow), startMin: 600, endMin: 660 }] };
  const d = buildDays(fullCal, svc, tomorrow, 2);
  assert(d[0].status === 'full' && d[1].status === 'open', 'a booked-out day is full, the next is open');
}

console.log('\n[5] Zone labels');
{
  const z = zoneTimes({ dateISO: '2026-11-05', startMin: 12 * 60, bizTz: 'America/New_York', viewerTz: 'America/Los_Angeles' });
  assert(z.differs && z.viewer === '9:00 am' && z.business === '12:00 pm', `noon in New York is 9:00 am in Los Angeles (${z.viewer})`);
  assert(dualTimeLabel({ dateISO: '2026-11-05', startMin: 720, bizTz: 'America/New_York', viewerTz: 'America/Los_Angeles', bizName: 'Maple Studio' })
    === "9:00 am your time / 12:00 pm Maple Studio's time", 'dual label wording');
  assert(!zoneTimes({ dateISO: '2026-11-05', startMin: 720, bizTz: 'America/New_York', viewerTz: 'America/Toronto' }).differs, 'same clock (different zone name) = no second label');
  assert(dualTimeLabel({ dateISO: '2026-11-05', startMin: 720, bizTz: 'America/New_York', viewerTz: 'America/New_York' }) === '12:00 pm', 'same zone = one time');
  const night = zoneTimes({ dateISO: '2026-11-05', startMin: 60, bizTz: 'America/New_York', viewerTz: 'America/Los_Angeles' });
  assert(night.differs && night.viewerFull === 'Wed 10:00 pm', `day change adds the weekday (${night.viewerFull})`);
  const summer = zoneTimes({ dateISO: '2026-07-01', startMin: 600, bizTz: 'Europe/London', viewerTz: 'America/New_York' });
  assert(summer.viewer === '5:00 am', `DST-correct (London 10:00 = New York 5:00 am in July, got ${summer.viewer})`);
  assert(!zoneTimes({ dateISO: '2026-11-05', startMin: 720, bizTz: null, viewerTz: 'America/New_York' }).differs, 'no business zone = no second label');
  assert(!zoneTimes({ dateISO: '2026-11-05', startMin: 720, bizTz: 'Not/AZone', viewerTz: 'America/New_York' }).differs, 'invalid zone never throws');
}

console.log('\n[6] Deep links ?service=');
{
  const services = [
    { id: '7f1c9a4e-1111-4b2b-9c3d-aaaaaaaaaaaa', name: 'Silk Press', visibility: 'public' },
    { id: '7f1c9a4e-2222-4b2b-9c3d-bbbbbbbbbbbb', name: 'Trim & Shape', visibility: 'public' },
    { id: '7f1c9a4e-3333-4b2b-9c3d-cccccccccccc', name: 'VIP Bridal Trial', visibility: 'private' },
  ];
  assert(resolveServiceParam(services, '7F1C9A4E-2222-4B2B-9C3D-BBBBBBBBBBBB')?.name === 'Trim & Shape', 'id match (case-insensitive)');
  assert(resolveServiceParam(services, 'silk-press')?.name === 'Silk Press', 'name slug match');
  assert(resolveServiceParam(services, 'Silk Press')?.name === 'Silk Press', 'plain name match');
  assert(resolveServiceParam(services, 'trim-shape')?.name === 'Trim & Shape', 'slug drops symbols');
  assert(resolveServiceParam(services, 'vip-bridal-trial')?.visibility === 'private', 'a private service resolves by direct link');
  assert(resolveServiceParam(services, 'massage') === null, 'unknown = null');
  assert(resolveServiceParam(services, '') === null && resolveServiceParam(services, null) === null, 'empty = null');
  assert(resolveServiceParam(services, '<script>alert(1)</script>') === null, 'markup = null');
  const t0 = Date.now();
  assert(resolveServiceParam(services, 'a'.repeat(200000)) === null && Date.now() - t0 < 200, 'huge input is capped and fast');
  assert(listedServices(services).length === 2, 'private services are not listed on the page');
  assert(listedServices(services, services[2].id).length === 3, 'the deep-linked private service is listed');
  assert(filterServices(services, 'TRIM').length === 1 && filterServices(services, '').length === 3, 'search is case-insensitive; empty shows all');
}

console.log('\n[7] Policy, formatting, contact links');
{
  const lines = policyLines({ price: 95, depositType: 'fixed', depositAmount: 20, cancellationFeeAmount: 25, cancellationWindowHours: 24, noShowFeeAmount: 40 });
  assert(lines.length === 3, 'deposit + cancellation + no-show lines');
  assert(lines[0] === 'A $20 deposit is due when you book.', lines[0]);
  assert(lines[1] === 'Cancelling within 1 day of your appointment may come with a $25 fee.', lines[1]);
  assert(policyLines({ price: 200, depositType: 'percent', depositAmount: 25 })[0] === 'A $50 deposit (25%) is due when you book.', 'percent deposit uses the total');
  assert(policyLines({ price: 50, depositType: 'fixed', depositAmount: 15, requireApproval: true })[0] === 'A $15 deposit is charged only once your time is confirmed.', 'a request service: deposit only once confirmed');
  assert(policyLines({ price: 80, depositType: 'full' })[0] === 'Paid in full when you book.', 'full payment');
  assert(policyLines({ price: 80, cancellationFeeAmount: 10, cancellationWindowHours: 6 })[0].includes('6 hours'), 'hour windows');
  assert(policyLines({ price: 80, depositType: 'none', cancellationFeeAmount: 0 }).length === 0, 'no policy configured = nothing shown');
  assert(policyLines({ price: 0, depositType: 'fixed', depositAmount: 20 }).length === 0, 'free service: no deposit line');
  assert(fmtDuration(30) === '30 min' && fmtDuration(60) === '1 hr' && fmtDuration(90) === '1 hr 30 min', 'durations');
  assert(fmtPrice(95) === '$95' && fmtPrice(95.5) === '$95.50' && fmtPrice(0) === 'Free', 'prices');
  assert(mapsUrl('214 Maple Ave, Brooklyn') === 'https://www.google.com/maps/search/?api=1&query=214%20Maple%20Ave%2C%20Brooklyn', 'maps link is encoded');
  assert(mapsUrl('') === null, 'no address = no link');
  assert(telHref('(718) 555-0142') === 'tel:7185550142' && telHref('+44 20 7946 0958') === 'tel:+442079460958', 'tel links');
  assert(telHref('call me') === null, 'not a number = no link');
}

console.log('\n[8] Remember me on this device (storage can fail)');
{
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  assert(readRemembered(storage) === null, 'nothing stored = null');
  writeRemembered(storage, { name: 'Ana', email: 'ana@example.com', phone: '555', smsConsent: true, extra: 'x' });
  const saved = JSON.parse(mem.get(REMEMBER_KEY));
  assert(JSON.stringify(Object.keys(saved).sort()) === '["email","name","phone"]', 'only name, email and phone are stored (never consent)');
  assert(readRemembered(storage)?.email === 'ana@example.com', 'read back');
  forgetRemembered(storage);
  assert(readRemembered(storage) === null, '"Not you?" clears it');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert(readRemembered(broken) === null && writeRemembered(broken, { name: 'a' }) === false, 'blocked storage never throws');
  forgetRemembered(broken);
  mem.set(REMEMBER_KEY, '{not json');
  assert(readRemembered(storage) === null, 'corrupt value = null');
  mem.set(REMEMBER_KEY, JSON.stringify({ name: 5, email: { a: 1 } }));
  assert(readRemembered(storage) === null, 'wrong types = null');
}

console.log('\n[9] Server: contact phone from the invoice contact block');
{
  assert(publicContactPhone('123 Main St\nAustin, TX 78701\n(512) 555-0100 · hello@x.com') === '(512) 555-0100', 'finds the phone, not the ZIP');
  assert(publicContactPhone('Austin, TX 78701 (512) 555-0100') === '(512) 555-0100', 'ZIP right before the phone');
  assert(publicContactPhone('Call +44 20 7946 0958') === '+44 20 7946 0958', 'international');
  assert(publicContactPhone('1-800-555-0199') === '1-800-555-0199', 'leading 1');
  assert(publicContactPhone('hello@x.com\nwww.x.com') === null, 'no phone = null');
  assert(publicContactPhone('Invoice 2026-11-05') === null, 'a date is not a phone');
  assert(publicContactPhone(null) === null && publicContactPhone(42) === null, 'non-string = null');
  const t0 = Date.now();
  publicContactPhone('1'.repeat(100000) + ' '.repeat(100000));
  publicContactPhone('+1 ' + '( '.repeat(50000));
  assert(Date.now() - t0 < 200, 'hostile input stays fast');
}

console.log('\n[10] Server: Outlook add-to-calendar link');
{
  const f = { bizName: 'Maple Studio', serviceName: 'Silk press', date: '2026-11-05', startMin: 600, endMin: 690, timezone: 'America/New_York', locationAddress: '214 Maple Ave', description: 'Booked with Maple Studio via Ivy.' };
  const u = new URL(buildOutlookCalendarUrl(f));
  assert(u.hostname === 'outlook.live.com' && u.searchParams.get('rru') === 'addevent', 'Outlook compose deep link');
  assert(u.searchParams.get('startdt') === '2026-11-05T15:00:00Z' && u.searchParams.get('enddt') === '2026-11-05T16:30:00Z', `UTC instant from the workspace zone (${u.searchParams.get('startdt')})`);
  assert(u.searchParams.get('subject') === 'Silk press with Maple Studio' && u.searchParams.get('location') === '214 Maple Ave', 'subject and location');
  const g = new URL(buildGoogleCalendarUrl(f));
  assert(g.searchParams.get('dates') === '20261105T150000Z/20261105T163000Z', 'same instant as the Google link');
  const floating = new URL(buildOutlookCalendarUrl({ ...f, timezone: null }));
  assert(floating.searchParams.get('startdt') === '2026-11-05T10:00:00', 'no zone = floating local time');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
