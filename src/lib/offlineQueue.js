// Two things an owner can do to a booking with no signal, kept on the
// phone and sent when the connection returns:
//   complete  mark the appointment complete
//   note      add a short private note (appended to the booking's private
//             notes; clients never see it)
//
// One entry per (kind, booking, date): tapping Complete twice, or editing
// the note, replaces the entry rather than adding a second one, and an
// entry is removed only once the server has confirmed it, so a flush that
// is interrupted sends the same change again, never a different one.
//
// Conflicts: the server wins. Before sending, the flush reads the booking
// back and, if it moved, was cancelled, or (for a note) its private notes
// changed since the owner saw them, the queued change is dropped and the
// caller shows a gentle toast. A booking the server already marked
// complete counts as done, not as a conflict.
//
// `client` is { get, post, patch } with the api.js shapes; it is passed in
// (never imported) so this module runs in Node for its tests.
import { getOfflineStorage } from './offlineStorage.js';

export const QUEUE_KEY = 'ivy_offline_queue';
export const QUEUE_MAX = 200;
const NOTE_MAX = 2000;

let items = [];
let primed = false;
let primePromise = null;
let flushing = null;
const listeners = new Set();

function emit() { for (const fn of listeners) { try { fn(); } catch { /* listener error */ } } }

async function persist() {
  const store = getOfflineStorage();
  if (!store) return;
  try {
    if (items.length) await store.set(QUEUE_KEY, JSON.stringify(items));
    else await store.remove(QUEUE_KEY);
  } catch { /* plugin error */ }
}

export function primeOfflineQueue() {
  if (primed) return Promise.resolve(items);
  if (primePromise) return primePromise;
  primePromise = (async () => {
    const store = getOfflineStorage();
    try {
      const raw = store ? await store.get(QUEUE_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : [];
      items = Array.isArray(parsed) ? parsed.filter((i) => i && i.key) : [];
    } catch { items = []; }
    primed = true;
    emit();
    return items;
  })();
  return primePromise;
}

export const queueKey = (kind, bookingId, occurrenceDate) => `${kind}:${bookingId}:${occurrenceDate}`;

// { kind, bookingId, occurrenceDate, clientName, note?, base: { date,
//   startMin, endMin, privateNotes } }. Returns the stored entry.
export function enqueueOfflineAction(input) {
  if (!input || !['complete', 'note'].includes(input.kind) || !input.bookingId || !input.occurrenceDate) return null;
  if (!getOfflineStorage()) return null;
  const entry = {
    key: queueKey(input.kind, input.bookingId, input.occurrenceDate),
    kind: input.kind,
    bookingId: String(input.bookingId),
    occurrenceDate: String(input.occurrenceDate).slice(0, 10),
    clientName: input.clientName ? String(input.clientName).slice(0, 160) : null,
    note: input.kind === 'note' ? String(input.note || '').trim().slice(0, NOTE_MAX) : null,
    base: {
      date: input.base?.date ?? null,
      startMin: input.base?.startMin ?? null,
      endMin: input.base?.endMin ?? null,
      privateNotes: input.base?.privateNotes ?? null,
    },
    queuedAt: new Date().toISOString(),
  };
  if (entry.kind === 'note' && !entry.note) return null;
  const idx = items.findIndex((i) => i.key === entry.key);
  if (idx >= 0) items[idx] = entry; else items.push(entry);
  if (items.length > QUEUE_MAX) items = items.slice(-QUEUE_MAX);
  persist();
  emit();
  return entry;
}

export function listOfflineQueue() { return items.slice(); }
export function queuedFor(bookingId, occurrenceDate) {
  return items.filter((i) => i.bookingId === String(bookingId) && (!occurrenceDate || i.occurrenceDate === occurrenceDate));
}
export function subscribeOfflineQueue(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export async function clearOfflineQueue() {
  items = [];
  const store = getOfflineStorage();
  if (store) { try { await store.remove(QUEUE_KEY); } catch { /* ignore */ } }
  emit();
}

function remove(key) {
  items = items.filter((i) => i.key !== key);
}

const isNetworkFail = (e) => !e || e.status === 0 || (e.status >= 500 && e.status < 600) || e.status === 401 || e.status === 429;

// Appends the queued note to what the owner saw.
export function appendNote(base, note) {
  const prev = (base || '').trim();
  return prev ? `${prev}\n${note}` : note;
}

// Reads the booking back as the server has it today. null = not there any
// more (cancelled or moved off that day).
async function fetchBooking(client, entry) {
  const day = entry.base.date || entry.occurrenceDate;
  const r = await client.get(`/calendar?from=${encodeURIComponent(day)}&to=${encodeURIComponent(day)}`, { retry: false, timeoutMs: 15000 });
  const list = r?.calendar?.bookings || [];
  const b = list.find((x) => x.id === entry.bookingId) || null;
  if (!b || b.cancelledAt) return null;
  if ((b.cancelledOccurrences || []).includes(entry.occurrenceDate)) return null;
  return b;
}

function moved(entry, b) {
  const base = entry.base || {};
  if (base.date != null && !b.recurrenceRule && b.date !== base.date) return true;
  if (base.startMin != null && Number(b.startMin) !== Number(base.startMin)) return true;
  if (base.endMin != null && Number(b.endMin) !== Number(base.endMin)) return true;
  return false;
}

// Sends everything queued. Resolves { synced, conflicts: [{ kind, clientName,
// reason }], kept } - `kept` entries stay for the next flush (still no
// signal, or the server was unavailable). Concurrent calls share one run.
export function flushOfflineQueue(client) {
  if (flushing) return flushing;
  flushing = (async () => {
    await primeOfflineQueue();
    const out = { synced: 0, conflicts: [], kept: 0 };
    for (const entry of items.slice()) {
      let b;
      try { b = await fetchBooking(client, entry); }
      catch (e) {
        if (isNetworkFail(e)) { out.kept += items.length - out.synced - out.conflicts.length; break; }
        // 4xx on the read: nothing we can do with this entry.
        remove(entry.key); out.conflicts.push({ kind: entry.kind, clientName: entry.clientName, reason: 'gone' }); continue;
      }
      if (!b) { remove(entry.key); out.conflicts.push({ kind: entry.kind, clientName: entry.clientName, reason: 'gone' }); continue; }
      if (moved(entry, b)) { remove(entry.key); out.conflicts.push({ kind: entry.kind, clientName: entry.clientName, reason: 'moved' }); continue; }
      try {
        if (entry.kind === 'complete') {
          const already = !!(b.completionLog || {})[entry.occurrenceDate];
          if (b.noShowAt) { remove(entry.key); out.conflicts.push({ kind: entry.kind, clientName: entry.clientName, reason: 'no-show' }); continue; }
          if (!already) await client.post('/calendar/bookings/complete', { id: entry.bookingId, occurrenceDate: entry.occurrenceDate }, { retry: false });
          remove(entry.key); out.synced += 1;
        } else {
          const serverNotes = b.privateNotes || null;
          const want = appendNote(entry.base.privateNotes, entry.note);
          if (serverNotes === want) { remove(entry.key); out.synced += 1; continue; }
          if ((serverNotes || null) !== (entry.base.privateNotes || null)) {
            remove(entry.key); out.conflicts.push({ kind: entry.kind, clientName: entry.clientName, reason: 'changed', note: entry.note }); continue;
          }
          await client.patch(`/calendar/bookings/${encodeURIComponent(entry.bookingId)}`, { privateNotes: want }, { retry: false });
          remove(entry.key); out.synced += 1;
        }
      } catch (e) {
        if (isNetworkFail(e)) { out.kept += 1; break; }
        // The server refused (already complete in a race, cancelled
        // meanwhile): its word stands.
        remove(entry.key);
        out.conflicts.push({ kind: entry.kind, clientName: entry.clientName, reason: 'refused', message: e?.message || '' });
      }
    }
    out.kept = items.length;
    await persist();
    emit();
    return out;
  })().finally(() => { flushing = null; });
  return flushing;
}

// Tests only.
export function resetOfflineQueueForTests() {
  items = []; primed = false; primePromise = null; flushing = null; listeners.clear();
}
