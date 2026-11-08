// The small on-device copy the iPhone app shows when there is no signal.
//
// What it holds (and nothing else):
//   bookings  today's and tomorrow's appointments: client, service, time,
//             address, phone, the owner's notes, video link
//   clients   the client list essentials: name, phone, email, address
//   threads   the last 20 conversations, each with its last 10 messages
//             (text only)
// Never payment details, tokens, documents or files, and never another
// workspace's data: the copy is stamped with the workspace it came from and
// wiped when a different workspace shows up (setSnapshotWorkspace) or the
// owner signs out (clearSnapshot, from auth.jsx) or taps "Clear saved data
// on this phone" in Account.
//
// Writes are debounced and capped at about 2 MB: when the copy would be
// larger, messages go first, then conversations, then clients, then
// bookings, so today's schedule is the last thing to give way.
//
// Reads are synchronous from memory once primeSnapshot() has run; screens
// use useSnapshot() (src/lib/useOffline.js) which primes and re-renders.
import { getOfflineStorage } from './offlineStorage.js';

export const SNAPSHOT_KEY = 'ivy_offline_snapshot';
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_LIMITS = { threads: 20, messagesPerThread: 10, clients: 1500, bookings: 200 };
const DEBOUNCE_MS = 1200;
const SECTIONS = ['bookings', 'clients', 'threads'];

let state = { ws: null, sections: {} };
let primed = false;
let primePromise = null;
let timer = null;
let listeners = new Set();
let pendingWs = null;

const str = (v, max) => (v == null ? null : String(v).slice(0, max) || null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// ── sanitizers: an allow-list per section, so a richer API object never
// drags payment or other fields onto the phone ──────────────────────────
export function pickBooking(b) {
  if (!b || !b.id) return null;
  return {
    id: String(b.id),
    date: str(b.date, 10),
    startMin: num(b.startMin),
    endMin: num(b.endMin),
    clientId: b.clientId ? String(b.clientId) : null,
    clientName: str(b.clientName, 160),
    clientPhone: str(b.clientPhone, 40),
    serviceId: b.serviceId ? String(b.serviceId) : null,
    serviceName: str(b.serviceName, 160),
    locationAddress: str(b.locationAddress, 300),
    notes: str(b.notes, 2000),
    privateNotes: str(b.privateNotes, 2000),
    videoUrl: str(b.videoUrl || b.videoRoomUrl, 500),
    threadId: b.threadId ? String(b.threadId) : null,
    completed: !!b.completed,
    noShow: !!b.noShow,
    // Set by the offline queue when Complete was tapped without signal.
    queued: !!b.queued,
  };
}

export function pickClient(c) {
  if (!c || !c.id) return null;
  return {
    id: String(c.id),
    name: str(c.name, 160),
    phone: str(c.phone, 40),
    email: str(c.email, 200),
    address: str(c.address, 300),
  };
}

export function pickMessage(m) {
  if (!m || !m.id) return null;
  // Text only: attachments, voice memos and files stay on the server.
  return { id: String(m.id), sender: str(m.sender, 20), text: str(m.text, 1000) || '', createdAt: str(m.createdAt, 40) };
}

export function pickThread(t, messages) {
  if (!t || !t.id) return null;
  const msgs = Array.isArray(messages) ? messages : (Array.isArray(t.messages) ? t.messages : []);
  return {
    id: String(t.id),
    clientId: t.clientId ? String(t.clientId) : null,
    clientName: str(t.clientName, 160),
    lastPreview: str(t.lastPreview, 200) || '',
    lastMessageAt: str(t.lastMessageAt, 40),
    unreadBiz: num(t.unreadBiz) || 0,
    messages: msgs.map(pickMessage).filter(Boolean).slice(-SNAPSHOT_LIMITS.messagesPerThread),
  };
}

function sanitize(section, items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (section === 'bookings') {
    const days = new Set([opts.today, opts.tomorrow].filter(Boolean));
    // The calendar payload has no phone; keep the one the dashboard saved.
    const prev = new Map((state.sections.bookings?.items || []).map((b) => [b.id, b]));
    return list.map((raw) => {
      const b = pickBooking(raw);
      if (b && !b.clientPhone && prev.get(b.id)?.clientPhone) b.clientPhone = prev.get(b.id).clientPhone;
      return b;
    }).filter((b) => b && (!days.size || days.has(b.date)))
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startMin || 0) - (b.startMin || 0))
      .slice(0, SNAPSHOT_LIMITS.bookings);
  }
  if (section === 'clients') return list.map(pickClient).filter(Boolean).slice(0, SNAPSHOT_LIMITS.clients);
  if (section === 'threads') {
    const prev = new Map((state.sections.threads?.items || []).map((t) => [t.id, t]));
    return list.slice(0, SNAPSHOT_LIMITS.threads).map((t) => {
      const picked = pickThread(t);
      // A fresh thread list carries no messages; keep the ones we saved
      // the last time that conversation was opened.
      if (picked && !picked.messages.length && prev.get(picked.id)) picked.messages = prev.get(picked.id).messages;
      return picked;
    }).filter(Boolean);
  }
  return [];
}

// ── size cap ────────────────────────────────────────────────────────────
export function bytesOf(obj) {
  const s = JSON.stringify(obj);
  // UTF-8 length without TextEncoder (Node and WebKit both fine either way).
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdfff) ? 2 : 3;
  }
  return n;
}

// Trims `snap` in place until it fits: messages, then whole conversations,
// then clients, then bookings (last, and from the end of tomorrow).
export function enforceCap(snap, max = SNAPSHOT_MAX_BYTES) {
  const sec = snap.sections;
  // Measure once, then subtract what each dropped item weighed; one exact
  // re-measure at the end (and a second pass if rounding left us over).
  for (let pass = 0; pass < 3; pass++) {
    let size = bytesOf(snap);
    if (size <= max) return snap;
    let guard = 0;
    while (size > max && guard++ < 50000) {
      const th = sec.threads?.items;
      let dropped;
      if (th && th.some((t) => t.messages.length)) {
        // Oldest message of the largest conversation first.
        const biggest = th.reduce((a, b) => (b.messages.length > (a?.messages.length || 0) ? b : a), null);
        dropped = biggest.messages.shift();
      } else if (th && th.length) dropped = th.pop();
      else if (sec.clients?.items?.length) dropped = sec.clients.items.pop();
      else if (sec.bookings?.items?.length) dropped = sec.bookings.items.pop();
      else return snap;
      size -= bytesOf(dropped) + 1;
    }
  }
  return snap;
}

// ── persistence ─────────────────────────────────────────────────────────
function emit() { for (const fn of listeners) { try { fn(); } catch { /* listener error */ } } }

async function persistNow() {
  const store = getOfflineStorage();
  if (!store) return;
  try {
    enforceCap(state);
    await store.set(SNAPSHOT_KEY, JSON.stringify(state));
  } catch { /* quota or plugin error: the copy is advisory */ }
}

function schedulePersist() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; persistNow(); }, DEBOUNCE_MS);
}

// Writes anything still waiting (tests, and the app going to background).
export async function flushSnapshotWrites() {
  if (timer) { clearTimeout(timer); timer = null; await persistNow(); }
}

export function primeSnapshot() {
  if (primed) return Promise.resolve(state);
  if (primePromise) return primePromise;
  primePromise = (async () => {
    const store = getOfflineStorage();
    try {
      const raw = store ? await store.get(SNAPSHOT_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && parsed.sections) {
        state = { ws: parsed.ws || null, sections: parsed.sections || {} };
      }
    } catch { state = { ws: null, sections: {} }; }
    primed = true;
    // A workspace named before the load finished: apply its scoping now.
    if (pendingWs) { const ws = pendingWs; pendingWs = null; applyWorkspace(ws); }
    emit();
    return state;
  })();
  return primePromise;
}

export function isSnapshotPrimed() { return primed; }

function applyWorkspace(ws) {
  if (state.ws && state.ws !== ws) {
    // Another workspace's copy: never shown, wiped at once.
    state = { ws, sections: {} };
    if (timer) { clearTimeout(timer); timer = null; }
    const store = getOfflineStorage();
    if (store) store.remove(SNAPSHOT_KEY).catch(() => {});
    emit();
    return;
  }
  if (state.ws !== ws) { state.ws = ws; schedulePersist(); }
}

// Names the workspace whose data may be saved and shown. Called by the app
// shell whenever the signed-in owner's workspace is known.
export function setSnapshotWorkspace(ws) {
  if (!ws) return;
  if (!primed) { pendingWs = String(ws); primeSnapshot(); return; }
  applyWorkspace(String(ws));
}

export function getSnapshotWorkspace() { return state.ws; }

// Save one section. Ignored before a workspace is known, so a race at
// launch can never attach data to the wrong account.
export function saveSnapshot(section, items, opts = {}) {
  if (!SECTIONS.includes(section) || !getOfflineStorage()) return false;
  if (!state.ws) return false;
  const picked = sanitize(section, items, opts);
  state.sections[section] = { savedAt: new Date().toISOString(), items: picked };
  schedulePersist();
  emit();
  return true;
}

// The last 10 messages of one conversation, text only. The thread must be
// one of the saved conversations (or there is room for it).
export function saveThreadMessages(thread, messages) {
  if (!thread?.id || !state.ws || !getOfflineStorage()) return false;
  const sec = state.sections.threads || { savedAt: null, items: [] };
  const picked = pickThread(thread, messages);
  if (!picked) return false;
  const idx = sec.items.findIndex((t) => t.id === picked.id);
  if (idx >= 0) sec.items[idx] = { ...sec.items[idx], ...picked, messages: picked.messages };
  else if (sec.items.length < SNAPSHOT_LIMITS.threads) sec.items.push(picked);
  else return false;
  sec.savedAt = new Date().toISOString();
  state.sections.threads = sec;
  schedulePersist();
  emit();
  return true;
}

// Marks a saved booking (after an offline Complete / note), so the screens
// reflect the queued change until the server copy replaces it.
export function patchSnapshotBooking(id, patch) {
  const sec = state.sections.bookings;
  if (!sec) return false;
  let hit = false;
  sec.items = sec.items.map((b) => (b.id === id ? (hit = true, pickBooking({ ...b, ...patch })) : b));
  if (hit) { schedulePersist(); emit(); }
  return hit;
}

// { items, savedAt } or null. Sync; null until primed or when nothing was saved.
export function readSnapshot(section) {
  const sec = state.sections[section];
  if (!sec || !Array.isArray(sec.items)) return null;
  return { items: sec.items, savedAt: sec.savedAt };
}

// The newest "saved at" across the sections a screen uses.
export function snapshotSavedAt(sections = SECTIONS) {
  let best = null;
  for (const s of sections) {
    const at = state.sections[s]?.savedAt;
    if (at && (!best || at > best)) best = at;
  }
  return best;
}

export function subscribeSnapshot(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Everything gone: memory and the device store. Sign-out, "Clear saved
// data on this phone", and a workspace change all land here.
export async function clearSnapshot() {
  state = { ws: null, sections: {} };
  pendingWs = null;
  if (timer) { clearTimeout(timer); timer = null; }
  const store = getOfflineStorage();
  if (store) { try { await store.remove(SNAPSHOT_KEY); } catch { /* ignore */ } }
  emit();
}

// Tests only: forget the in-memory copy so the next prime reads the store.
export function resetSnapshotForTests() {
  state = { ws: null, sections: {} };
  primed = false; primePromise = null; pendingWs = null;
  if (timer) { clearTimeout(timer); timer = null; }
  listeners = new Set();
}

// "9:41 AM" in the owner's local time, for the offline bar.
export function fmtSavedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
