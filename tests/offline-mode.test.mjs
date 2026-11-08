// Works without signal (iPhone app, 1.0.6): the on-device snapshot store,
// the offline detector and the queue of changes made offline. Pure
// modules, exercised with a memory store in Node.
//   1. snapshot: allow-listed fields only, today/tomorrow only, caps, 2 MB
//   2. snapshot: scoped to one workspace, cleared on sign-out
//   3. detector: navigator.onLine + a failed fetch, cleared by any answer
//   4. queue: one entry per booking, idempotent flush, server wins
//   5. tap-to-call / directions links and sign-out wiring
// Run: node --import ./tests/bootstrap.mjs ./tests/offline-mode.test.mjs
import fs from 'node:fs';
import { setOfflineStorageForTests, memoryOfflineStorage } from '../src/lib/offlineStorage.js';
import {
  SNAPSHOT_KEY, SNAPSHOT_LIMITS, SNAPSHOT_MAX_BYTES, bytesOf, enforceCap,
  primeSnapshot, setSnapshotWorkspace, saveSnapshot, saveThreadMessages, readSnapshot, clearSnapshot,
  flushSnapshotWrites, resetSnapshotForTests, patchSnapshotBooking, fmtSavedAt, snapshotSavedAt,
} from '../src/lib/snapshot.js';
import {
  isOffline, setBrowserOnline, noteNetworkFailure, noteNetworkSuccess, subscribeOffline, noteOfflineRequest,
  subscribeOfflineRequests, resetOfflineForTests, OFFLINE_MESSAGE,
} from '../src/lib/offline.js';
import {
  QUEUE_KEY, enqueueOfflineAction, listOfflineQueue, flushOfflineQueue, clearOfflineQueue, primeOfflineQueue,
  resetOfflineQueueForTests, appendNote, queuedFor,
} from '../src/lib/offlineQueue.js';
import { clearOfflineData } from '../src/lib/offlineData.js';
import { telHref, mapsHref, phoneForBooking, nextBookingFor } from '../src/lib/offlineLinks.js';
import { bookingsForSnapshot } from '../src/features/calendar/offlineSnapshot.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const read = (f) => fs.readFileSync(f, 'utf8');

const store = memoryOfflineStorage();
setOfflineStorageForTests(store);
const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = iso(today);
const TOMORROW = iso(new Date(today.getTime() + 86400e3));
const NEXT_WEEK = iso(new Date(today.getTime() + 7 * 86400e3));

async function fresh(ws = 'ws-a') {
  resetSnapshotForTests();
  store._map.clear();
  await primeSnapshot();
  setSnapshotWorkspace(ws);
}

console.log('\n[1] snapshot keeps only what the brief lists');
await fresh();
const richBooking = {
  id: 'b1', date: TODAY, startMin: 600, endMin: 660, clientId: 'c1', clientName: 'Jane Cooper', clientPhone: '(555) 010-2000',
  serviceName: 'Silk press', locationAddress: '12 Main St', notes: 'Gate code 4411', privateNotes: 'Allergic to latex',
  videoRoomUrl: 'https://zoom.us/j/1', threadId: 't1', completed: false,
  depositPaid: 50, bookingTotal: 120, payment: { status: 'paid' }, customFieldValues: { secret: 1 }, clientEmail: 'jane@example.com',
};
assert(saveSnapshot('bookings', [richBooking, { ...richBooking, id: 'b2', date: NEXT_WEEK }, { ...richBooking, id: 'b3', date: TOMORROW }], { today: TODAY, tomorrow: TOMORROW }), 'saves bookings once a workspace is known');
let snap = readSnapshot('bookings');
assert(snap && snap.items.length === 2 && snap.items.map((b) => b.id).join() === 'b1,b3', 'only today and tomorrow are kept (next week dropped)');
const kept = snap.items[0];
assert(kept.clientName === 'Jane Cooper' && kept.clientPhone === '(555) 010-2000' && kept.locationAddress === '12 Main St' && kept.notes === 'Gate code 4411' && kept.privateNotes === 'Allergic to latex' && kept.videoUrl === 'https://zoom.us/j/1', 'name, phone, address, notes, private note, video link are kept');
assert(!('depositPaid' in kept) && !('bookingTotal' in kept) && !('payment' in kept) && !('customFieldValues' in kept) && !('clientEmail' in kept), 'payment fields and anything not listed are dropped');
assert(typeof snap.savedAt === 'string' && !Number.isNaN(Date.parse(snap.savedAt)), 'stamped with when it was saved');

saveSnapshot('clients', [{ id: 'c1', name: 'Jane Cooper', phone: '555', email: 'j@x.com', address: '12 Main St', lifetimeValue: 900, notes: 'vip', tags: ['a'] }]);
const cl = readSnapshot('clients').items[0];
assert(cl.name === 'Jane Cooper' && cl.phone === '555' && cl.email === 'j@x.com' && cl.address === '12 Main St' && !('lifetimeValue' in cl) && !('notes' in cl) && !('tags' in cl), 'clients keep name, phone, email, address only');

const threads = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, clientId: `c${i}`, clientName: `Client ${i}`, lastPreview: 'hi', lastMessageAt: '2026-11-08T10:00:00Z', unreadBiz: 0, clientEmail: 'x@y.z', mode: 'two-way' }));
saveSnapshot('threads', threads);
assert(readSnapshot('threads').items.length === SNAPSHOT_LIMITS.threads, `thread list capped at ${SNAPSHOT_LIMITS.threads}`);
const msgs = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, threadId: 't0', sender: i % 2 ? 'biz' : 'client', text: `msg ${i}`, attachments: [{ url: 'https://blob/x.jpg' }], createdAt: `2026-11-08T10:${String(i).padStart(2, '0')}:00Z` }));
assert(saveThreadMessages(threads[0], msgs), 'messages of a saved conversation are kept');
const t0 = readSnapshot('threads').items.find((t) => t.id === 't0');
assert(t0.messages.length === SNAPSHOT_LIMITS.messagesPerThread && t0.messages[0].text === 'msg 15' && t0.messages[9].text === 'msg 24', 'last 10 messages only');
assert(!('attachments' in t0.messages[0]) && !('clientEmail' in t0), 'text only: attachments and emails are not saved');
assert(!saveThreadMessages({ id: 't99', clientName: 'Extra' }, msgs), 'a 21st conversation is not added');
saveSnapshot('threads', threads.slice(0, 5));
assert(readSnapshot('threads').items.find((t) => t.id === 't0').messages.length === 10, 'refreshing the thread list keeps the saved messages');

// 2 MB cap
const huge = { ws: 'ws-a', sections: {
  bookings: { savedAt: 'x', items: Array.from({ length: 50 }, (_, i) => ({ id: `b${i}`, notes: 'n'.repeat(20000) })) },
  clients: { savedAt: 'x', items: Array.from({ length: 1500 }, (_, i) => ({ id: `c${i}`, name: 'x'.repeat(160), email: 'e'.repeat(200), address: 'a'.repeat(300), phone: 'p'.repeat(40) })) },
  threads: { savedAt: 'x', items: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, messages: Array.from({ length: 10 }, (_, j) => ({ id: `${i}-${j}`, text: 'm'.repeat(1000) })) })) },
} };
const before = bytesOf(huge);
enforceCap(huge);
assert(before > SNAPSHOT_MAX_BYTES && bytesOf(huge) <= SNAPSHOT_MAX_BYTES, `over-size copy (${before} bytes) is trimmed under ${SNAPSHOT_MAX_BYTES}`);
assert(huge.sections.bookings.items.length === 50, 'bookings are the last to give way');
const tiny = { ws: 'w', sections: { bookings: { savedAt: 'x', items: [{ id: 'b', notes: 'x'.repeat(3 * 1024 * 1024) }] } } };
enforceCap(tiny);
assert(bytesOf(tiny) <= SNAPSHOT_MAX_BYTES, 'even bookings give way when they alone exceed the cap');

await flushSnapshotWrites();
const onDisk = JSON.parse(store._map.get(SNAPSHOT_KEY));
assert(onDisk.ws === 'ws-a' && onDisk.sections.bookings.items.length === 2 && onDisk.sections.clients.items.length === 1, 'persisted to the device store with the workspace stamp');
assert(!JSON.stringify(onDisk).includes('depositPaid') && !JSON.stringify(onDisk).includes('jane@example.com'), 'nothing unlisted reaches the device store');
assert(patchSnapshotBooking('b1', { completed: true, queued: true }) && readSnapshot('bookings').items[0].completed === true, 'a queued Complete marks the saved booking');
assert(/^\d{1,2}:\d{2}\s?(AM|PM)$/i.test(fmtSavedAt(new Date().toISOString())), `savedAt reads as a local time (${fmtSavedAt(new Date().toISOString())})`);
assert(snapshotSavedAt() === readSnapshot('threads').savedAt || snapshotSavedAt() >= readSnapshot('bookings').savedAt, 'snapshotSavedAt is the newest section');

console.log('\n[2] one workspace only; sign-out clears the phone');
resetSnapshotForTests();
await primeSnapshot(); // re-reads what [1] persisted for ws-a
assert(readSnapshot('bookings') === null && snapshotSavedAt() === null, 'a relaunch shows nothing until the signed-in workspace is confirmed');
setSnapshotWorkspace('ws-a');
assert(readSnapshot('bookings')?.items.length === 2, 'same workspace confirmed: the saved copy is read back');
setSnapshotWorkspace('ws-b');
assert(readSnapshot('bookings') === null && readSnapshot('clients') === null && readSnapshot('threads') === null, 'another workspace signs in: the copy is gone from memory');
await new Promise((r) => setTimeout(r, 20));
assert(!store._map.has(SNAPSHOT_KEY), 'and from the device store');
saveSnapshot('bookings', [richBooking], { today: TODAY, tomorrow: TOMORROW });
await flushSnapshotWrites();
assert(JSON.parse(store._map.get(SNAPSHOT_KEY)).ws === 'ws-b', 'new saves are stamped with the new workspace');
// Pending workspace before prime finishes: a race at launch.
resetSnapshotForTests();
setSnapshotWorkspace('ws-c');
await primeSnapshot();
assert(readSnapshot('bookings') === null && !store._map.has(SNAPSHOT_KEY), 'workspace named before the load finished still wipes another workspace\'s copy');
// No workspace known: saves are refused.
resetSnapshotForTests(); store._map.clear(); await primeSnapshot();
assert(!saveSnapshot('bookings', [richBooking], { today: TODAY, tomorrow: TOMORROW }) && readSnapshot('bookings') === null, 'nothing is saved before the workspace is known');
// Sign-out: snapshot + queue both go.
await fresh('ws-a');
saveSnapshot('clients', [{ id: 'c1', name: 'Jane' }]);
await flushSnapshotWrites();
enqueueOfflineAction({ kind: 'complete', bookingId: 'b1', occurrenceDate: TODAY, clientName: 'Jane', base: { date: TODAY, startMin: 600, endMin: 660 } });
await new Promise((r) => setTimeout(r, 10));
assert(store._map.has(SNAPSHOT_KEY) && store._map.has(QUEUE_KEY), 'precondition: a copy and a queued change are on the device');
await clearOfflineData();
assert(!store._map.has(SNAPSHOT_KEY) && !store._map.has(QUEUE_KEY) && readSnapshot('clients') === null && listOfflineQueue().length === 0, 'clearOfflineData empties the device store and memory');
// "Clear saved data on this phone" (still signed in): gone, and a fresh
// copy starts at once for the same workspace.
await fresh('ws-a');
saveSnapshot('clients', [{ id: 'c1', name: 'Jane' }]);
await flushSnapshotWrites();
await clearOfflineData({ keepWorkspace: true });
assert(!store._map.has(SNAPSHOT_KEY) && readSnapshot('clients') === null, 'the Account button empties the device store and memory');
assert(saveSnapshot('clients', [{ id: 'c2', name: 'Kim' }]) && readSnapshot('clients')?.items[0].name === 'Kim', 'after the Account button, the next screen load saves a fresh copy');
await flushSnapshotWrites();
assert(JSON.parse(store._map.get(SNAPSHOT_KEY)).ws === 'ws-a', 'the fresh copy is stamped with the same workspace');
await clearOfflineData();
assert(!saveSnapshot('clients', [{ id: 'c3', name: 'Lee' }]) && readSnapshot('clients') === null, 'after sign-out nothing is saved until the next owner is confirmed');
// Someone else's copy left on the phone is never read back.
await fresh('ws-a');
saveSnapshot('clients', [{ id: 'c1', name: 'Jane' }]);
await flushSnapshotWrites();
resetSnapshotForTests();
await primeSnapshot();
assert(readSnapshot('clients') === null, 'relaunch: the copy stays hidden before anyone is confirmed');
setSnapshotWorkspace('ws-z');
assert(readSnapshot('clients') === null && !store._map.has(SNAPSHOT_KEY), 'a different owner is confirmed: wiped without ever being shown');
const authSrc = read('src/lib/auth.jsx');
assert(authSrc.includes("import { clearOfflineData } from './offlineData.js'") && /finally\s*\{[\s\S]*?clearOfflineData\(\)/.test(authSrc), 'signOut in auth.jsx calls clearOfflineData (network or not)');
assert(read('src/features/account/AccountPage.jsx').includes('<SavedOnPhoneCard/>') && read('src/components/offline/SavedOnPhoneCard.jsx').includes('Clear saved data on this phone'), 'Account has the "Clear saved data on this phone" card');
assert(read('public/sw.js').includes("if (sameOrigin && url.pathname.startsWith('/api/')) return;"), 'the service worker still never caches /api responses');
assert(!read('src/lib/snapshot.js').includes('localStorage') && !read('src/lib/offlineQueue.js').includes('localStorage'), 'the copy lives in the app sandbox store, not localStorage');

console.log('\n[3] offline detector');
resetOfflineForTests();
const seen = [];
subscribeOffline((v) => seen.push(v));
assert(!isOffline(), 'starts online');
assert(noteNetworkFailure({ status: 0, message: 'Load failed' }) && isOffline(), 'a fetch with no answer (status 0) means offline');
assert(!noteNetworkFailure({ status: 500 }) && isOffline(), 'a 500 is not a signal problem (state unchanged)');
noteNetworkSuccess();
assert(!isOffline(), 'any answered request puts us back online');
assert(!noteNetworkFailure({ status: 0, name: 'AbortError', aborted: true }) && !isOffline(), 'our own timeouts do not count');
setBrowserOnline(false);
assert(isOffline(), 'navigator.onLine === false means offline');
noteNetworkSuccess();
assert(isOffline(), 'while the browser says offline, a stray success does not flip it');
setBrowserOnline(true);
assert(!isOffline() && seen.join() === 'true,false,true,false', `listeners see each change (${seen.join()})`);
let toasts = 0;
subscribeOfflineRequests(() => { toasts += 1; });
assert(noteOfflineRequest(1000) && !noteOfflineRequest(2000) && noteOfflineRequest(8000) && toasts === 2, 'request toasts are throttled to one per 6 seconds');
assert(OFFLINE_MESSAGE === "You're offline. Try again when you have signal.", 'the plain reason');
const apiSrc = read('src/lib/api.js');
assert(apiSrc.includes('noteNetworkFailure(err)') && apiSrc.includes('noteNetworkSuccess()') && apiSrc.includes('err.message = OFFLINE_MESSAGE'), 'api.js reports failures/answers and uses the plain message when offline');

console.log('\n[4] queued Complete and private note');
resetOfflineQueueForTests(); store._map.delete(QUEUE_KEY);
await primeOfflineQueue();
const base = { date: TODAY, startMin: 600, endMin: 660, privateNotes: null };
assert(enqueueOfflineAction({ kind: 'complete', bookingId: 'b1', occurrenceDate: TODAY, clientName: 'Jane Cooper', base }), 'Complete is queued');
enqueueOfflineAction({ kind: 'complete', bookingId: 'b1', occurrenceDate: TODAY, clientName: 'Jane Cooper', base });
assert(listOfflineQueue().length === 1, 'tapping Complete twice keeps one entry');
assert(!enqueueOfflineAction({ kind: 'note', bookingId: 'b1', occurrenceDate: TODAY, note: '   ', base }), 'an empty note is not queued');
enqueueOfflineAction({ kind: 'note', bookingId: 'b1', occurrenceDate: TODAY, clientName: 'Jane Cooper', note: 'Bring the blue cape', base });
enqueueOfflineAction({ kind: 'note', bookingId: 'b1', occurrenceDate: TODAY, clientName: 'Jane Cooper', note: 'Bring the blue cape, and towels', base });
assert(listOfflineQueue().length === 2 && queuedFor('b1', TODAY).find((q) => q.kind === 'note').note === 'Bring the blue cape, and towels', 'editing the note replaces the queued note');
assert(!enqueueOfflineAction({ kind: 'cancel', bookingId: 'b1', occurrenceDate: TODAY }), 'only Complete and a note can be queued');
await new Promise((r) => setTimeout(r, 10));
assert(JSON.parse(store._map.get(QUEUE_KEY)).length === 2, 'the queue is on the device store');

// A fake server: the booking as the server has it + a log of writes.
function fakeApi(server) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(['GET', path]);
      if (server.network === 'down') throw Object.assign(new Error(OFFLINE_MESSAGE), { status: 0, offline: true });
      return { calendar: { bookings: server.bookings } };
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (server.network === 'down') throw Object.assign(new Error('x'), { status: 0 });
      if (server.refuseComplete) throw Object.assign(new Error('This booking is already marked complete'), { status: 400 });
      const b = server.bookings.find((x) => x.id === body.id);
      b.completionLog = { ...(b.completionLog || {}), [body.occurrenceDate]: { completedAt: new Date().toISOString() } };
      return { booking: b };
    },
    async patch(path, body) {
      calls.push(['PATCH', path, body]);
      const id = decodeURIComponent(path.split('/').pop());
      const b = server.bookings.find((x) => x.id === id);
      b.privateNotes = body.privateNotes;
      return { booking: b };
    },
  };
}
const server = { bookings: [{ id: 'b1', date: TODAY, startMin: 600, endMin: 660, privateNotes: null, completionLog: {} }] };
let api = fakeApi({ ...server, network: 'down' });
let r = await flushOfflineQueue(api);
assert(r.synced === 0 && r.kept === 2 && listOfflineQueue().length === 2, 'no signal: nothing is sent, everything is kept');
api = fakeApi(server);
r = await flushOfflineQueue(api);
assert(r.synced === 2 && r.conflicts.length === 0 && r.kept === 0, `back online: both changes sync (${JSON.stringify(r)})`);
assert(api.calls.filter((c) => c[0] === 'POST').length === 1 && server.bookings[0].completionLog[TODAY], 'Complete was sent exactly once');
assert(server.bookings[0].privateNotes === 'Bring the blue cape, and towels', 'the note was appended to the private notes');
assert(api.calls.every((c) => c[0] !== 'GET' || c[1].includes('/calendar?from=')), 'the booking is read back first (server state wins)');
r = await flushOfflineQueue(api);
assert(r.synced === 0 && api.calls.filter((c) => c[0] === 'POST' || c[0] === 'PATCH').length === 2, 'a second flush sends nothing (idempotent)');
assert(appendNote('old', 'new') === 'old\nnew' && appendNote('', 'new') === 'new' && appendNote(null, 'n') === 'n', 'notes append below what was there');

// Server wins: the booking moved.
enqueueOfflineAction({ kind: 'complete', bookingId: 'b1', occurrenceDate: TODAY, clientName: 'Jane Cooper', base: { ...base } });
server.bookings[0].startMin = 720; server.bookings[0].endMin = 780; server.bookings[0].completionLog = {};
api = fakeApi(server);
r = await flushOfflineQueue(api);
assert(r.synced === 0 && r.conflicts.length === 1 && r.conflicts[0].reason === 'moved' && r.conflicts[0].clientName === 'Jane Cooper', 'booking rescheduled meanwhile: Complete is dropped as a conflict');
assert(api.calls.every((c) => c[0] !== 'POST') && listOfflineQueue().length === 0, 'nothing was sent and the entry is gone');
// Server wins: the private notes changed meanwhile.
server.bookings[0].startMin = 600; server.bookings[0].endMin = 660; server.bookings[0].privateNotes = 'Edited on the laptop';
enqueueOfflineAction({ kind: 'note', bookingId: 'b1', occurrenceDate: TODAY, clientName: 'Jane Cooper', note: 'offline note', base: { ...base, privateNotes: null } });
api = fakeApi(server);
r = await flushOfflineQueue(api);
assert(r.conflicts.length === 1 && r.conflicts[0].reason === 'changed' && server.bookings[0].privateNotes === 'Edited on the laptop' && api.calls.every((c) => c[0] !== 'PATCH'), 'private notes edited elsewhere: the server keeps its version, nothing is overwritten');
// Server already complete: counts as done, not a conflict.
server.bookings[0].completionLog = { [TODAY]: { completedAt: 'x' } };
enqueueOfflineAction({ kind: 'complete', bookingId: 'b1', occurrenceDate: TODAY, clientName: 'Jane Cooper', base: { ...base } });
api = fakeApi(server);
r = await flushOfflineQueue(api);
assert(r.synced === 1 && r.conflicts.length === 0 && api.calls.every((c) => c[0] !== 'POST'), 'already complete on the server: done, with no second POST and no conflict');
// Booking cancelled meanwhile.
server.bookings[0].completionLog = {}; server.bookings[0].cancelledAt = '2026-11-08T00:00:00Z';
enqueueOfflineAction({ kind: 'complete', bookingId: 'b1', occurrenceDate: TODAY, clientName: 'Jane Cooper', base: { ...base } });
r = await flushOfflineQueue(fakeApi(server));
assert(r.conflicts.length === 1 && r.conflicts[0].reason === 'gone', 'cancelled meanwhile: dropped as a conflict');
// Server refuses the POST (race): its word stands.
delete server.bookings[0].cancelledAt;
enqueueOfflineAction({ kind: 'complete', bookingId: 'b1', occurrenceDate: TODAY, clientName: 'Jane Cooper', base: { ...base } });
r = await flushOfflineQueue(fakeApi({ ...server, refuseComplete: true }));
assert(r.conflicts.length === 1 && r.conflicts[0].reason === 'refused' && listOfflineQueue().length === 0, 'a 4xx from the server drops the entry (server wins)');
// Relaunch: the queue survives in the store.
enqueueOfflineAction({ kind: 'complete', bookingId: 'b2', occurrenceDate: TOMORROW, clientName: 'Sam', base: { date: TOMORROW, startMin: 60, endMin: 120 } });
await new Promise((r2) => setTimeout(r2, 10));
resetOfflineQueueForTests();
await primeOfflineQueue();
assert(listOfflineQueue().length === 1 && listOfflineQueue()[0].bookingId === 'b2', 'queued changes survive a relaunch');
await clearOfflineQueue();
assert(listOfflineQueue().length === 0 && !store._map.has(QUEUE_KEY), 'clearOfflineQueue empties memory and the store');

console.log('\n[5] links and the calendar snapshot');
assert(telHref('(555) 010-2000') === 'tel:5550102000' && telHref('+1 555 010 2000') === 'tel:+15550102000' && telHref('x') === null && telHref('') === null, 'tel: links from phone numbers');
assert(mapsHref('12 Main St, Austin') === 'https://maps.apple.com/?q=12%20Main%20St%2C%20Austin' && mapsHref('  ') === null, 'Apple Maps links from addresses');
assert(phoneForBooking({ clientPhone: '1234567' }, []) === '1234567' && phoneForBooking({ clientId: 'c1' }, [{ id: 'c1', phone: '7654321' }]) === '7654321' && phoneForBooking({ clientId: 'zz' }, []) === null, 'a booking\'s phone comes from the booking or the saved client');
const nb = nextBookingFor('c1', [{ clientId: 'c1', date: TOMORROW, startMin: 60, endMin: 120 }, { clientId: 'c1', date: TODAY, startMin: 0, endMin: 30 }, { clientId: 'c1', date: TODAY, startMin: 1380, endMin: 1430 }], TODAY, 600);
assert(nb && nb.date === TODAY && nb.startMin === 1380, 'next appointment skips ones already over today');
const calendar = {
  services: [{ id: 's1', name: 'Silk press' }],
  bookings: [
    { id: 'b1', date: TODAY, startMin: 600, endMin: 660, serviceId: 's1', clientName: 'Jane', completionLog: { [TODAY]: {} }, locationAddress: '12 Main St' },
    { id: 'r1', date: iso(new Date(today.getTime() - 7 * 86400e3)), startMin: 540, endMin: 600, serviceId: 's1', clientName: 'Weekly Will', recurrenceRule: 'weekly' },
    { id: 'c1', date: TODAY, startMin: 700, endMin: 760, serviceId: 's1', clientName: 'Gone', cancelledAt: '2026-01-01' },
    { id: 'n1', date: NEXT_WEEK, startMin: 700, endMin: 760, serviceId: 's1', clientName: 'Later' },
  ],
};
const fromCal = bookingsForSnapshot(calendar, today);
assert(fromCal.today === TODAY && fromCal.tomorrow === TOMORROW, 'today/tomorrow in local time');
const ids = fromCal.items.map((b) => `${b.id}@${b.date}`).sort();
assert(ids.join() === [`b1@${TODAY}`, `r1@${TODAY}`].sort().join(), `today's single + the weekly occurrence, not cancelled or next week (${ids.join()})`);
assert(fromCal.items.find((b) => b.id === 'b1').completed === true && fromCal.items.find((b) => b.id === 'b1').serviceName === 'Silk press', 'completion and service name ride along');
const sheet = read('src/components/offline/OfflineBookingSheet.jsx');
assert(sheet.includes("kind: 'complete'") && sheet.includes("kind: 'note'") && !sheet.includes('onCancelOccurrence') && !sheet.includes('rescheduleTo'), 'the offline sheet offers Complete and a private note, nothing else');
assert(read('src/lib/native.js').includes('maps\\.apple\\.com'), 'maps.apple.com opens in the Maps app, not the in-app browser sheet');
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
