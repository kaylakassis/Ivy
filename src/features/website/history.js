// Undo history for the website editor. Plain functions with no React or
// browser globals, so they can be unit tested in node
// (tests/website-history.test.mjs). state.js owns the live copy.
//
// Model
//   • A snapshot is the owner's draft content (DRAFT_KEYS) as a JSON string.
//     Strings are cheap to size-check and can never be mutated by a later
//     edit.
//   • `past` holds the snapshots before each step, oldest first. `future`
//     holds what redo returns to, most recent last.
//   • Typing in one field is one step: a change whose only difference is a
//     single text value (same field as the previous change, within
//     COALESCE_MS of it) extends the previous step instead of adding one.
//     Discrete actions (add, delete, move, duplicate, page and style changes)
//     always start a new step.
//   • The last publish is the save point. Publishing clears undo and redo,
//     so history never reaches back past what is live.
//   • Memory cap: MAX_STEPS snapshots or MAX_BYTES of them, whichever comes
//     first; the oldest are dropped silently. "Discard changes" goes to the
//     server's published copy, so it stays exact whatever was dropped here.
//   • Persistence (survives a reload): serializeHistory / restoreHistory.
//     A stored history is used only when it was written for the same
//     publish (publishedAt) and its newest snapshot matches the draft the
//     server just returned. Anything else (an Ivy edit, another device, a
//     publish elsewhere, a save that never landed) starts fresh.

export const COALESCE_MS = 1000;
export const MAX_STEPS = 300;
export const MAX_BYTES = 5 * 1024 * 1024;
// localStorage is roughly 5M UTF-16 characters per origin and is shared with
// the rest of the app, so the stored copy is kept well under that.
export const PERSIST_MAX_CHARS = 1_500_000;
export const STORAGE_VERSION = 1;

// The parts of the site an owner edits and undo restores. Server-managed
// fields (publishedAt, domainStatus, scheduledPublishAt, launched) and the
// custom domain (detaching it has side effects) are deliberately left out.
export const DRAFT_KEYS = [
  'businessName', 'handle', 'template', 'fontPair', 'customCss', 'visibility',
  'pages', 'seoTitle', 'seoDescription', 'seoOgImage', 'faviconUrl',
  'redirects', 'formDestinations', 'exitIntentPopup', 'stickyCta',
];

export function draftOf(site) {
  const out = {};
  for (const k of DRAFT_KEYS) out[k] = site?.[k] === undefined ? null : site[k];
  return out;
}

export function snapshotOf(site) {
  return JSON.stringify(draftOf(site));
}

export function emptyHistory(publishedAt = null) {
  return { past: [], future: [], bytes: 0, lastKey: null, lastAt: 0, publishedAt: publishedAt || null };
}

// ── Coalescing ──────────────────────────────────────────────────────

const isTextLeaf = (v) => v == null || typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object';

// Collect up to `limit` differing leaf paths between a and b. Shared
// subtrees (same reference) are skipped, which is what keeps this cheap on
// every keystroke: the editor's updates copy only the changed branch.
function diffPaths(a, b, path, out, limit) {
  if (out.length > limit) return;
  if (a === b) return;
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a)) {
      if (a.length !== b.length) { out.push({ path, a, b, structural: true }); return; }
      for (let i = 0; i < a.length; i++) {
        diffPaths(a[i], b[i], path.concat(i), out, limit);
        if (out.length > limit) return;
      }
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      diffPaths(a[k], b[k], path.concat(k), out, limit);
      if (out.length > limit) return;
    }
    return;
  }
  // Treat a missing value and an empty one as the same text field state.
  if ((a == null || a === '') && (b == null || b === '')) return;
  out.push({ path, a, b, structural: isObj(a) || isObj(b) });
}

// Site-level fields that are free text (typing coalesces).
const SITE_TEXT = new Set([
  'businessName', 'handle', 'customCss', 'seoTitle', 'seoDescription', 'seoOgImage', 'faviconUrl',
  'exitIntentPopup', 'stickyCta',
]);
const PAGE_TEXT = new Set(['title', 'metaTitle', 'metaDescription', 'ogImage']);

// Returns a key naming the one text field that changed between two drafts,
// or null when the change is anything else (a discrete step). `prev` and
// `next` are draft objects (draftOf).
export function coalesceKey(prev, next) {
  if (!prev || !next) return null;
  const diffs = [];
  diffPaths(prev, next, [], diffs, 1);
  if (diffs.length !== 1) return null;
  const d = diffs[0];
  if (d.structural || !isTextLeaf(d.a) || !isTextLeaf(d.b)) return null;
  // Booleans and numbers fail isTextLeaf above; only text edits coalesce.
  if (typeof d.a !== 'string' && typeof d.b !== 'string') return null;
  const p = d.path;
  if (p[0] === 'pages' && typeof p[1] === 'number') {
    const page = next.pages[p[1]];
    if (!page) return null;
    if (p.length === 3 && PAGE_TEXT.has(p[2])) return `page:${page.id}:${p[2]}`;
    // pages.i.sections.j.data.<field...>: content typed into a section.
    if (p[2] === 'sections' && typeof p[3] === 'number' && p[4] === 'data' && p.length >= 6) {
      const sec = page.sections?.[p[3]];
      if (!sec) return null;
      return `sec:${page.id}:${sec.id}:${p.slice(5).join('.')}`;
    }
    return null; // style, variant, animate, visible, slug... are discrete
  }
  if (SITE_TEXT.has(p[0])) return `site:${p.join('.')}`;
  return null;
}

// ── Recording, undo, redo ───────────────────────────────────────────

function capped(h) {
  let { past, bytes } = h;
  if (past.length <= MAX_STEPS && bytes <= MAX_BYTES) return h;
  past = past.slice();
  while (past.length > 1 && (past.length > MAX_STEPS || bytes > MAX_BYTES)) {
    bytes -= past.shift().length;
  }
  return { ...h, past, bytes };
}

// Record a change from `prevSnap` (the draft before the change). `key` is
// coalesceKey(prev, next). Returns the new history.
export function recordChange(h, prevSnap, key, now = Date.now()) {
  if (
    key && h.lastKey === key && h.past.length > 0 && h.future.length === 0
    && now - h.lastAt <= COALESCE_MS
  ) {
    // Same field, still typing: the step that started this run already
    // holds the state from before the first keystroke.
    return { ...h, lastAt: now };
  }
  return capped({
    ...h,
    past: h.past.concat(prevSnap),
    future: [],
    bytes: h.bytes + prevSnap.length,
    lastKey: key || null,
    lastAt: now,
  });
}

// Pushes `currentSnap` as a discrete step (used before Discard changes, so
// the discard can be undone).
export function recordDiscrete(h, currentSnap, now = Date.now()) {
  return recordChange(h, currentSnap, null, now);
}

export function canUndo(h) { return h.past.length > 0; }
export function canRedo(h) { return h.future.length > 0; }

// Returns { history, snap } where snap is the draft to show, or null.
export function undoStep(h, currentSnap) {
  if (h.past.length === 0) return null;
  const past = h.past.slice();
  const snap = past.pop();
  return {
    snap,
    history: {
      ...h, past, bytes: h.bytes - snap.length,
      future: h.future.concat(currentSnap),
      lastKey: null, lastAt: 0,
    },
  };
}

export function redoStep(h, currentSnap) {
  if (h.future.length === 0) return null;
  const future = h.future.slice();
  const snap = future.pop();
  return {
    snap,
    history: capped({
      ...h, future,
      past: h.past.concat(currentSnap),
      bytes: h.bytes + currentSnap.length,
      lastKey: null, lastAt: 0,
    }),
  };
}

// Publishing sets a new save point: nothing before it can be undone.
export function markPublished(h, publishedAt) {
  return emptyHistory(publishedAt ?? h?.publishedAt ?? null);
}

// ── Persistence ─────────────────────────────────────────────────────

export function storageKey(prefix, userId, siteId) {
  if (!userId || !siteId) return null;
  return `${prefix}${userId}:${siteId}`;
}

const sameInstant = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Number.isFinite(ta) && ta === tb;
};

// JSON for localStorage, or null when even the current draft alone is too
// big to keep. Oldest steps are dropped first, then redo steps.
export function serializeHistory(h, currentSnap, maxChars = PERSIST_MAX_CHARS) {
  if (typeof currentSnap !== 'string') return null;
  let past = h.past;
  let future = h.future;
  const size = () => currentSnap.length + past.reduce((n, s) => n + s.length, 0)
    + future.reduce((n, s) => n + s.length, 0) + 200;
  let total = size();
  if (total > maxChars) {
    past = past.slice();
    future = future.slice();
    while (total > maxChars && past.length) total -= past.shift().length;
    while (total > maxChars && future.length) total -= future.shift().length;
    if (total > maxChars) return null;
  }
  return JSON.stringify({
    v: STORAGE_VERSION,
    publishedAt: h.publishedAt || null,
    current: currentSnap,
    past, future,
  });
}

// Canonical form for comparing a stored draft with the server's copy:
// key order is ignored, empty values (null, undefined, '') are treated as
// absent, and a page with no inNav counts as in the nav (the server fills
// those in when it saves).
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (!isObj(v)) return v;
  const out = {};
  for (const k of Object.keys(v).sort()) {
    const x = v[k];
    if (x === undefined || x === null || x === '') continue;
    out[k] = canon(x);
  }
  return out;
}

function canonDraft(d) {
  const c = { ...(d || {}) };
  if (Array.isArray(c.pages)) {
    c.pages = c.pages.map((p) => (isObj(p) ? { ...p, inNav: p.inNav !== false } : p));
  }
  return canon(c);
}

export function draftsEqual(a, b) {
  return JSON.stringify(canonDraft(a)) === JSON.stringify(canonDraft(b));
}

// Parse a stored history and keep it only if it belongs to this exact
// draft and publish. `serverDraft` is draftOf(the site the server returned).
export function restoreHistory(raw, { serverDraft, publishedAt }) {
  if (!raw || typeof raw !== 'string') return null;
  let o;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || o.v !== STORAGE_VERSION) return null;
  if (typeof o.current !== 'string') return null;
  const strings = (a) => Array.isArray(a) && a.every((s) => typeof s === 'string');
  if (!strings(o.past) || !strings(o.future)) return null;
  if (!sameInstant(o.publishedAt, publishedAt)) return null;
  let current;
  try { current = JSON.parse(o.current); } catch { return null; }
  if (!draftsEqual(current, serverDraft)) return null;
  if (o.past.length === 0 && o.future.length === 0) return null;
  return capped({
    past: o.past.slice(),
    future: o.future.slice(),
    bytes: o.past.reduce((n, s) => n + s.length, 0),
    lastKey: null,
    lastAt: 0,
    publishedAt: publishedAt || null,
  });
}
