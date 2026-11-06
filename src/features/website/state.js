// Website state - sourced from /api/website.
// Local edits update immediately; writes are debounced to the server.
//
// Multi-page model:
//   site.pages is the source of truth. Each page = { id, slug, title,
//   sections[], inNav }. The legacy `site.sections` field is kept in
//   sync as a mirror of the home page (slug='') so any code path that
//   still reads `sections` continues to work.
//
//   currentPageId tracks which page the editor is editing right now -
//   local-only state, not persisted.
//
// Undo history: see history.js. Every change is one step (typing in one
// field coalesces), history reaches back to the last publish, and it is
// kept in localStorage per account + site so it survives a reload.
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { api } from '../../lib/api.js';
import { SITE_HISTORY_PREFIX } from '../../lib/deviceCache.js';
import { IVY_ACTIONS_RAN_EVENT } from '../ivy/openIvy.js';
import * as H from './history.js';
import {
  cloneSection, moveSectionWithinPage, uniquePageSlug, findSectionPage,
  moveSectionToPage as moveToPage, copySectionToPage as copyToPage,
} from './pageTransforms.js';
import { isLegacyCodeType } from './sections.js';

let pageCounter = 0;
function mkPageId() {
  pageCounter += 1;
  return `pg_${Date.now().toString(36)}_${pageCounter}`;
}

export function mkPage({ slug = '', title = 'New page', sections = [], inNav = true } = {}) {
  return { id: mkPageId(), slug, title, sections, inNav };
}

export const DEFAULT_SITE = {
  launched: false,
  businessName: '',
  handle: '',
  template: 'clean',
  fontPair: null,
  customCss: '',
  customDomain: '',
  domainStatus: null,
  visibility: 'public',
  publishedAt: null,
  sections: [],
  pages: [],
  seoTitle: '',
  seoDescription: '',
  seoOgImage: '',
  faviconUrl: '',
  redirects: [],
  formDestinations: [],
  exitIntentPopup: null,
  stickyCta: null,
  scheduledPublishAt: null,
};

function normalize(w) {
  if (!w) return DEFAULT_SITE;
  // If pages is empty, seed with a home page that mirrors the legacy
  // sections array. Subsequent edits land in pages[0].sections; we
  // keep the top-level sections in sync on every write.
  let pages = Array.isArray(w.pages) ? w.pages : [];
  const legacySections = Array.isArray(w.sections) ? w.sections : [];
  if (pages.length === 0) {
    pages = [{ id: mkPageId(), slug: '', title: 'Home', sections: legacySections, inNav: true }];
  }
  return {
    launched:     !!w.launched,
    businessName: w.businessName || '',
    handle:       w.handle || '',
    template:     w.template || 'clean',
    fontPair:     w.fontPair || null,
    customCss:    w.customCss || '',
    customDomain: w.customDomain || '',
    domainStatus: w.domainStatus || null,
    visibility:   w.visibility || 'public',
    publishedAt:  w.publishedAt || null,
    pages,
    sections:     pages.find((p) => p.slug === '')?.sections || pages[0]?.sections || [],
    seoTitle:        w.seoTitle || '',
    seoDescription:  w.seoDescription || '',
    seoOgImage:      w.seoOgImage || '',
    faviconUrl:      w.faviconUrl || '',
    redirects:         Array.isArray(w.redirects) ? w.redirects : [],
    formDestinations:  Array.isArray(w.formDestinations) ? w.formDestinations : [],
    exitIntentPopup:   w.exitIntentPopup || null,
    stickyCta:         w.stickyCta || null,
    scheduledPublishAt: w.scheduledPublishAt || null,
  };
}

// Debounced server write - every change is coalesced into a single PUT.
// `onSaved(response)` runs after a save lands with nothing newer queued.
function useDebouncedPut(delay = 600, onSaved = null) {
  const pendingRef  = useRef(null);
  const timerRef    = useRef(null);
  const inflightRef = useRef(null);
  const onSavedRef  = useRef(onSaved);
  onSavedRef.current = onSaved;
  const [error, setError]     = useState(null);
  const [saving, setSaving]   = useState(false);

  const flush = useCallback(async () => {
    clearTimeout(timerRef.current);
    // A save already on the wire must land before the next one (or a
    // publish / discard) goes out, so requests never overtake each other.
    if (inflightRef.current) { try { await inflightRef.current; } catch { /* reported below */ } }
    if (!pendingRef.current) return;
    const body = pendingRef.current;
    pendingRef.current = null;
    setSaving(true);
    const p = (async () => {
      try {
        const r = await api.put('/website', body);
        setError(null);
        if (!pendingRef.current && onSavedRef.current) onSavedRef.current(r);
      } catch (e) {
        setError(e);
      } finally {
        setSaving(false);
      }
    })();
    inflightRef.current = p;
    await p;
    if (inflightRef.current === p) inflightRef.current = null;
  }, []);

  const schedule = useCallback((body) => {
    pendingRef.current = body;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, delay);
  }, [delay, flush]);

  const cancel = useCallback(() => {
    clearTimeout(timerRef.current);
    pendingRef.current = null;
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // An edit waiting for its debounce timer (not yet sent).
  const hasPending = useCallback(() => !!pendingRef.current, []);
  // Wait for a save already on the wire, without sending a queued one.
  const settle = useCallback(async () => {
    if (inflightRef.current) { try { await inflightRef.current; } catch { /* reported by flush */ } }
  }, []);

  return { schedule, flush, cancel, saving, error, hasPending, settle };
}

const withHomeMirror = (next) => {
  const home = next.pages.find((p) => p.slug === '') || next.pages[0];
  return { ...next, sections: home ? home.sections : [] };
};

function readStored(key) {
  if (!key) return null;
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key, value) {
  if (!key) return;
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Quota or private mode: drop the stored copy rather than leave a
    // stale one behind. Undo still works for this session.
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
}

// True when `server` is just what the editor saved for `local`, with the
// shaping PUT /api/website applies to pages (sanitizePage drops empty SEO
// fields and normalises inNav), so a round trip is not mistaken for an
// outside change.
function canonPages(pages) {
  return JSON.stringify((pages || []).map((p) => {
    const o = { id: p.id, slug: p.slug || '', title: p.title || 'Untitled', sections: p.sections || [], inNav: p.inNav !== false };
    for (const k of ['metaTitle', 'metaDescription', 'ogImage']) if (p[k]) o[k] = p[k];
    return o;
  }));
}
function sameAsSaved(local, server) {
  const a = H.draftOf(local), b = H.draftOf(server);
  for (const k of Object.keys(a)) {
    if (k === 'pages') { if (canonPages(a.pages) !== canonPages(b.pages)) return false; }
    else if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null) && (a[k] || b[k])) return false;
  }
  return true;
}

// `target` is a page id, or { title } to create a new page first (the new
// page and the move are one undo step).
function resolveTarget(s, target) {
  if (target && typeof target === 'object') {
    const title = String(target.title || 'New page').trim().slice(0, 120) || 'New page';
    const page = mkPage({ title, slug: uniquePageSlug(title, s.pages) });
    return { pages: [...s.pages, page], pageId: page.id };
  }
  return { pages: s.pages, pageId: target };
}

export function useWebsite({ userId = null } = {}) {
  const [site, setSiteState]  = useState(DEFAULT_SITE);
  const siteRef = useRef(DEFAULT_SITE);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [currentPageId, setCurrentPageId] = useState(null);
  const currentPageIdRef = useRef(null);
  currentPageIdRef.current = currentPageId;
  // True when the live site is published but the draft has edits not yet
  // pushed live (drives the "unpublished changes → Publish" cue).
  const [dirty, setDirty] = useState(false);
  const loadedRef = useRef(false);

  // ── Undo / redo history (history.js) ─────────────────────────────
  // historyRef holds the current history value; snapRef the snapshot of
  // the draft on screen (what the next change records as "before").
  const historyRef = useRef(H.emptyHistory());
  const snapRef    = useRef(null);
  const storageKeyRef = useRef(null);
  const [historyTick, setHistoryTick] = useState(0);
  const setHistory = useCallback((h) => {
    historyRef.current = h;
    setHistoryTick((t) => t + 1);
  }, []);

  const persistHistory = useCallback(() => {
    const key = storageKeyRef.current;
    if (!key || snapRef.current == null) return;
    const h = historyRef.current;
    if (!H.canUndo(h) && !H.canRedo(h)) { writeStored(key, null); return; }
    writeStored(key, H.serializeHistory(h, snapRef.current));
  }, []);

  // A save landed and nothing newer is queued: the server's draft now
  // matches snapRef, so the stored history can be refreshed, and the
  // server's own view of "unpublished changes" is the accurate one.
  const onSaved = useCallback((r) => {
    if (r?.website && typeof r.website.hasUnpublishedChanges === 'boolean') {
      setDirty(r.website.hasUnpublishedChanges);
    }
    persistHistory();
  }, [persistHistory]);
  const { schedule, flush, cancel, saving, error: saveErr, hasPending, settle } = useDebouncedPut(600, onSaved);

  const setSite = useCallback((next) => {
    siteRef.current = next;
    setSiteState(next);
  }, []);

  useEffect(() => {
    let live = true;
    api.get('/website')
      .then((r) => {
        if (!live) return;
        const n = normalize(r.website);
        setSite(n);
        snapRef.current = H.snapshotOf(n);
        setDirty(!!r.website?.hasUnpublishedChanges);
        // Restore the stored history only when it was written for exactly
        // this draft and this publish. After an Ivy edit, a publish, or an
        // edit on another device, the draft differs and we start fresh.
        const key = H.storageKey(SITE_HISTORY_PREFIX, userId, r.website?.id);
        storageKeyRef.current = key;
        const restored = H.restoreHistory(readStored(key), {
          serverDraft: H.draftOf(n), publishedAt: n.publishedAt,
        });
        setHistory(restored || H.emptyHistory(n.publishedAt));
        if (!restored) writeStored(key, null);
        const home = n.pages.find((p) => p.slug === '') || n.pages[0];
        if (home) setCurrentPageId(home.id);
        loadedRef.current = true;
      })
      .catch((e) => live && setLoadErr(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  // userId is read once at load; the key never changes mid-session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleWrite = useCallback((next) => {
    setDirty(true); // any draft edit means there are unpublished changes
    const home = next.pages.find((p) => p.slug === '') || next.pages[0];
    schedule({
      handle:        next.handle,
      businessName:  next.businessName,
      template:      next.template,
      fontPair:      next.fontPair,
      customCss:     next.customCss,
      sections:      home ? home.sections : [],
      pages:         next.pages,
      customDomain:  next.customDomain,
      launched:      next.launched,
      visibility:    next.visibility || 'public',
      seoTitle:        next.seoTitle,
      seoDescription:  next.seoDescription,
      seoOgImage:      next.seoOgImage,
      faviconUrl:      next.faviconUrl,
      redirects:         next.redirects,
      formDestinations:  next.formDestinations,
      exitIntentPopup:   next.exitIntentPopup,
      stickyCta:         next.stickyCta,
      scheduledPublishAt: next.scheduledPublishAt,
    });
  }, [schedule]);

  // Apply a new site state: render it, record the undo step, autosave.
  // Runs synchronously against siteRef (not inside a setState updater) so
  // helpers can read the result and StrictMode never records a step twice.
  const commit = useCallback((next) => {
    const prev = siteRef.current;
    if (next === prev) return prev;
    const synced = withHomeMirror(next);
    setSite(synced);
    if (!loadedRef.current) return synced;
    const prevSnap = snapRef.current;
    const nextSnap = H.snapshotOf(synced);
    snapRef.current = nextSnap;
    // The wizard's first build is not an undo step (undoing it would leave
    // an empty site); everything after launch is.
    if (prev.launched && prevSnap != null && nextSnap !== prevSnap) {
      const key = H.coalesceKey(H.draftOf(prev), H.draftOf(synced));
      setHistory(H.recordChange(historyRef.current, prevSnap, key));
    }
    scheduleWrite(synced);
    return synced;
  }, [setSite, setHistory, scheduleWrite]);

  const mutate = useCallback((updater) => {
    const prev = siteRef.current;
    const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
    return commit(next);
  }, [commit]);

  // Show a snapshot from history. If the step changed a page other than
  // the one on screen (say, undoing a move to another page), switch to the
  // page that changed so the owner sees what undo did.
  const applySnapshot = useCallback((snap) => {
    const cur = siteRef.current;
    const draft = JSON.parse(snap);
    const next = withHomeMirror({ ...cur, ...draft, pages: Array.isArray(draft.pages) ? draft.pages : cur.pages });
    setSite(next);
    snapRef.current = snap;
    scheduleWrite(next);
    const pageNow = currentPageIdRef.current;
    const before = new Map(cur.pages.map((p) => [p.id, p]));
    const changed = next.pages.filter((p) => JSON.stringify(before.get(p.id)) !== JSON.stringify(p));
    const countDelta = (p) => (p.sections?.length || 0) - (before.get(p.id)?.sections?.length || 0);
    const nowChanged = changed.find((p) => p.id === pageNow);
    // A section that moved between pages: follow it to the page it lands on.
    const gained = changed.find((p) => p.id !== pageNow && countDelta(p) > 0);
    if (!next.pages.some((p) => p.id === pageNow)) {
      const home = next.pages.find((p) => p.slug === '') || next.pages[0];
      setCurrentPageId(changed[0]?.id || home?.id || null);
    } else if (changed.length && !nowChanged) {
      setCurrentPageId(changed[0].id);
    } else if (nowChanged && countDelta(nowChanged) < 0 && gained) {
      setCurrentPageId(gained.id);
    }
  }, [setSite, scheduleWrite]);

  const undo = useCallback(() => {
    const r = H.undoStep(historyRef.current, snapRef.current);
    if (!r) return;
    setHistory(r.history);
    applySnapshot(r.snap);
  }, [applySnapshot, setHistory]);

  const redo = useCallback(() => {
    const r = H.redoStep(historyRef.current, snapRef.current);
    if (!r) return;
    setHistory(r.history);
    applySnapshot(r.snap);
  }, [applySnapshot, setHistory]);

  // historyTick only forces a re-render when the history changes.
  void historyTick;
  const canUndo = H.canUndo(historyRef.current);
  const canRedo = H.canRedo(historyRef.current);

  const set = useCallback((patch) => mutate(patch), [mutate]);

  // ── Page-aware helpers ─────────────────────────────────────────────

  const updatePage = useCallback((pageId, updater) => mutate((s) => ({
    ...s,
    pages: s.pages.map((p) => p.id === pageId
      ? (typeof updater === 'function' ? updater(p) : { ...p, ...updater })
      : p),
  })), [mutate]);

  const currentPage = useMemo(
    () => site.pages.find((p) => p.id === currentPageId) || site.pages[0] || null,
    [site.pages, currentPageId],
  );

  const setSection = useCallback((id, patch) => {
    if (!currentPage) return;
    updatePage(currentPage.id, (p) => ({
      ...p,
      sections: p.sections.map((sec) =>
        sec.id === id ? { ...sec, ...patch, data: { ...sec.data, ...(patch.data || {}) } } : sec,
      ),
    }));
  }, [currentPage, updatePage]);

  const addSection = useCallback((sec) => {
    if (!currentPage) return;
    updatePage(currentPage.id, (p) => ({ ...p, sections: [...p.sections, sec] }));
  }, [currentPage, updatePage]);

  const removeSection = useCallback((id) => {
    if (!currentPage) return;
    updatePage(currentPage.id, (p) => ({ ...p, sections: p.sections.filter((sec) => sec.id !== id) }));
  }, [currentPage, updatePage]);

  // Clone a section and drop it right after the original. Deep-copies
  // `data` and copies `style/variant/animate` shallowly.
  const duplicateSection = useCallback((id) => {
    if (!currentPage) return;
    updatePage(currentPage.id, (p) => {
      const i = p.sections.findIndex((sec) => sec.id === id);
      if (i < 0) return p;
      // Legacy code sections can stay, but never multiply (the server
      // refuses a new one too).
      if (isLegacyCodeType(p.sections[i].type)) return p;
      const next = p.sections.slice();
      next.splice(i + 1, 0, cloneSection(p.sections[i]));
      return { ...p, sections: next };
    });
  }, [currentPage, updatePage]);

  const moveSection = useCallback((id, dir) => {
    if (!currentPage) return;
    updatePage(currentPage.id, (p) => {
      const i = p.sections.findIndex((sec) => sec.id === id);
      if (i < 0) return p;
      const j = dir === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= p.sections.length) return p;
      const next = p.sections.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return { ...p, sections: next };
    });
  }, [currentPage, updatePage]);

  // Move a section to an exact index in the list. Used by drag-and-drop
  // so the user can yank a section from position 4 to position 0 without
  // pressing the up arrow four times.
  const moveSectionTo = useCallback((id, targetIndex) => {
    if (!currentPage) return;
    updatePage(currentPage.id, (p) => {
      const next = moveSectionWithinPage(p.sections, id, targetIndex);
      return next === p.sections ? p : { ...p, sections: next };
    });
  }, [currentPage, updatePage]);

  // Move a section (from any page) to another page. One undo step.
  // Returns { moved, pageId, relinked, unlinked }.
  const moveSectionToPage = useCallback((sectionId, target, position = 'bottom') => {
    let out = { moved: false, pageId: null, relinked: 0, unlinked: 0 };
    mutate((s) => {
      const t = resolveTarget(s, target);
      const r = moveToPage(t.pages, sectionId, t.pageId, position);
      if (!r.moved) return s;
      out = { moved: true, pageId: t.pageId, relinked: r.relinked, unlinked: r.unlinked };
      return { ...s, pages: r.pages };
    });
    return out;
  }, [mutate]);

  // Copy a section onto another page with fresh ids. One undo step.
  // Returns { copied, pageId, newId }.
  const copySectionToPage = useCallback((sectionId, target, position = 'bottom') => {
    let out = { copied: false, pageId: null, newId: null };
    mutate((s) => {
      const src = findSectionPage(s.pages, sectionId)?.sections.find((x) => x.id === sectionId);
      if (src && isLegacyCodeType(src.type)) return s;
      const t = resolveTarget(s, target);
      const r = copyToPage(t.pages, sectionId, t.pageId, position);
      if (!r.copied) return s;
      out = { copied: true, pageId: t.pageId, newId: r.newId };
      return { ...s, pages: r.pages };
    });
    return out;
  }, [mutate]);

  // ── Page-level helpers ─────────────────────────────────────────────

  const addPage = useCallback((init = {}) => {
    const newPage = mkPage(init);
    mutate((s) => ({ ...s, pages: [...s.pages, newPage] }));
    setCurrentPageId(newPage.id);
    return newPage;
  }, [mutate]);

  const removePage = useCallback((pageId) => {
    let nextFallbackId = null;
    mutate((s) => {
      const remaining = s.pages.filter((p) => p.id !== pageId);
      if (remaining.length === 0) return s;
      // Always preserve a home page (slug='').
      if (!remaining.some((p) => p.slug === '')) {
        remaining[0] = { ...remaining[0], slug: '', title: remaining[0].title || 'Home' };
      }
      nextFallbackId = remaining[0].id;
      return { ...s, pages: remaining };
    });
    setCurrentPageId((curr) => curr === pageId ? nextFallbackId : curr);
  }, [mutate]);

  const renamePage = useCallback((pageId, patch) => {
    updatePage(pageId, (p) => ({
      ...p,
      ...(patch.title != null ? { title: String(patch.title).slice(0, 120) } : {}),
      ...(patch.slug != null ? { slug: String(patch.slug).toLowerCase().slice(0, 40) } : {}),
      ...(patch.inNav != null ? { inNav: !!patch.inNav } : {}),
      // Per-page SEO. Empty string clears the override; the renderer
      // falls through to site-level seoTitle / seoDescription / seoOgImage.
      ...(patch.metaTitle != null ? { metaTitle: String(patch.metaTitle).slice(0, 200) } : {}),
      ...(patch.metaDescription != null ? { metaDescription: String(patch.metaDescription).slice(0, 400) } : {}),
      ...(patch.ogImage != null ? { ogImage: String(patch.ogImage).slice(0, 1000) } : {}),
    }));
  }, [updatePage]);

  const movePage = useCallback((pageId, dir) => {
    mutate((s) => {
      const i = s.pages.findIndex((p) => p.id === pageId);
      if (i < 0) return s;
      const j = dir === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= s.pages.length) return s;
      const next = s.pages.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return { ...s, pages: next };
    });
  }, [mutate]);

  // Move a page to a specific index. Mirrors moveSectionTo for drag/drop
  // on the page tabs strip.
  const movePageTo = useCallback((pageId, targetIndex) => {
    mutate((s) => {
      const i = s.pages.findIndex((p) => p.id === pageId);
      if (i < 0) return s;
      const next = s.pages.slice();
      const [item] = next.splice(i, 1);
      const clamped = Math.max(0, Math.min(next.length, targetIndex));
      next.splice(clamped, 0, item);
      return { ...s, pages: next };
    });
  }, [mutate]);

  const reset = useCallback(async () => {
    // Start over is not undoable (the confirm says so): drop the history.
    cancel();
    setSite(DEFAULT_SITE);
    snapRef.current = H.snapshotOf(DEFAULT_SITE);
    setHistory(H.emptyHistory(siteRef.current.publishedAt));
    writeStored(storageKeyRef.current, null);
    try {
      await api.put('/website', {
        handle: null, businessName: null, template: 'clean',
        sections: [], pages: [], customCss: null, fontPair: null,
        customDomain: null, launched: false,
        seoTitle: null, seoDescription: null, seoOgImage: null, faviconUrl: null,
      });
    }
    catch (e) { setLoadErr(e); }
  }, [cancel, setSite, setHistory]);

  const publish = useCallback(async () => {
    await flush();
    const r = await api.post('/website/publish');
    setSite({ ...siteRef.current, launched: true, publishedAt: r.published_at });
    setDirty(false); // draft is now the published snapshot
    // New save point: nothing before this publish can be undone.
    setHistory(H.markPublished(historyRef.current, r.published_at));
    writeStored(storageKeyRef.current, null);
    return r;
  }, [flush, setSite, setHistory]);

  // Throw away every draft edit since the last publish. The server copies
  // the published pages back onto the draft; the pre-discard draft becomes
  // an undo step so a mis-tap can be undone.
  const discardChanges = useCallback(async () => {
    await flush();
    const r = await api.post('/website/discard-draft');
    const n = normalize(r.website);
    const cur = siteRef.current;
    const prevSnap = snapRef.current;
    const next = withHomeMirror({ ...cur, pages: n.pages });
    setSite(next);
    snapRef.current = H.snapshotOf(next);
    if (prevSnap != null && snapRef.current !== prevSnap) {
      setHistory(H.recordDiscrete(historyRef.current, prevSnap));
    }
    setDirty(!!r.website?.hasUnpublishedChanges);
    if (!next.pages.some((p) => p.id === currentPageIdRef.current)) {
      const home = next.pages.find((p) => p.slug === '') || next.pages[0];
      setCurrentPageId(home?.id || null);
    }
    persistHistory();
    return r;
  }, [flush, setSite, setHistory, persistHistory]);

  // Roll back to a published version from Advanced > History. Any pending
  // autosave goes out first (so it cannot land after the restore and
  // overwrite it), then the editor adopts what the server now holds. The
  // pre-restore draft becomes one undo step.
  const restoreVersion = useCallback(async (versionId) => {
    await flush();
    await api.post('/website/versions', { id: versionId });
    const r = await api.get('/website');
    const n = normalize(r.website);
    const prevSnap = snapRef.current;
    const next = withHomeMirror(n);
    setSite(next);
    snapRef.current = H.snapshotOf(next);
    if (prevSnap != null && snapRef.current !== prevSnap) {
      setHistory(H.recordDiscrete(historyRef.current, prevSnap));
    }
    setDirty(!!r.website?.hasUnpublishedChanges);
    if (!next.pages.some((p) => p.id === currentPageIdRef.current)) {
      const home = next.pages.find((p) => p.slug === '') || next.pages[0];
      setCurrentPageId(home?.id || null);
    }
    persistHistory();
    return r;
  }, [flush, setSite, setHistory, persistHistory]);

  // Ivy edits the same draft on the server (after the owner approves), and
  // so can another device. When the owner approves an Ivy action, or comes
  // back to this tab, adopt the server's draft if it differs from the one on
  // screen. The draft that was on screen becomes one undo step, so Ivy's
  // change can be undone here like any other. If the owner is mid-edit (a
  // save still queued) we skip this round: their save goes out and wins,
  // exactly as it would have before.
  const syncingRef = useRef(false);
  const lastSyncRef = useRef(0);
  const syncFromServer = useCallback(async ({ force = false } = {}) => {
    if (!loadedRef.current || syncingRef.current) return;
    if (!force && Date.now() - lastSyncRef.current < 3000) return;
    syncingRef.current = true;
    lastSyncRef.current = Date.now();
    try {
      await settle();
      if (hasPending()) return;
      const r = await api.get('/website');
      // A legacy single-page site (no pages saved yet) gets fresh page ids
      // from normalize on every read, so it can never be compared; Ivy
      // always saves pages, so its edits are never in that shape.
      if (!r?.website || !Array.isArray(r.website.pages) || r.website.pages.length === 0) return;
      if (hasPending()) return; // the owner typed while we were reading
      const n = normalize(r.website);
      const prevSnap = snapRef.current;
      const cur = siteRef.current;
      // Server-managed fields always follow the server.
      const next = withHomeMirror({ ...cur, ...n });
      const nextSnap = H.snapshotOf(next);
      setDirty(!!r.website.hasUnpublishedChanges);
      if (nextSnap === prevSnap || sameAsSaved(cur, next)) {
        if (n.publishedAt !== cur.publishedAt || n.scheduledPublishAt !== cur.scheduledPublishAt) {
          setSite({ ...cur, launched: n.launched, publishedAt: n.publishedAt, scheduledPublishAt: n.scheduledPublishAt });
        }
        return;
      }
      setSite(next);
      snapRef.current = nextSnap;
      if (n.publishedAt && n.publishedAt !== historyRef.current.publishedAt) {
        // Published from elsewhere (Ivy): that is the new save point.
        setHistory(H.markPublished(historyRef.current, n.publishedAt));
      } else if (prevSnap != null) {
        setHistory(H.recordDiscrete(historyRef.current, prevSnap));
      }
      if (!next.pages.some((p) => p.id === currentPageIdRef.current)) {
        const home = next.pages.find((p) => p.slug === '') || next.pages[0];
        setCurrentPageId(home?.id || null);
      }
      persistHistory();
    } catch {
      // Offline or a hiccup: the next focus or approval tries again.
    } finally {
      syncingRef.current = false;
    }
  }, [settle, hasPending, setSite, setHistory, persistHistory]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onIvy = () => { syncFromServer({ force: true }); };
    const onFocus = () => { syncFromServer(); };
    const onVis = () => { if (document.visibilityState === 'visible') syncFromServer(); };
    window.addEventListener(IVY_ACTIONS_RAN_EVENT, onIvy);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener(IVY_ACTIONS_RAN_EVENT, onIvy);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [syncFromServer]);

  // Schedule the CURRENT draft to go live at `whenISO`. We snapshot the
  // current pages into scheduled_pages so later draft edits don't change
  // what gets published at the scheduled time; the cron promotes it.
  const schedulePublish = useCallback(async (whenISO) => {
    await flush();
    const r = await api.put('/website', { scheduledPublishAt: whenISO, scheduledPages: siteRef.current.pages });
    setSite({ ...siteRef.current, scheduledPublishAt: r.website?.scheduledPublishAt || whenISO });
    return r;
  }, [flush, setSite]);

  const cancelSchedule = useCallback(async () => {
    const r = await api.put('/website', { scheduledPublishAt: null, scheduledPages: null });
    setSite({ ...siteRef.current, scheduledPublishAt: null });
    return r;
  }, [setSite]);

  return {
    site, loading, loadErr, saving, saveErr,
    hasUnpublishedChanges: dirty,
    schedulePublish, cancelSchedule,
    currentPage, currentPageId, setCurrentPageId,
    addPage, removePage, renamePage, movePage, movePageTo,
    set, setSection, addSection, removeSection, moveSection, moveSectionTo, duplicateSection,
    moveSectionToPage, copySectionToPage,
    reset, publish, flush, discardChanges, restoreVersion, syncFromServer,
    undo, redo, canUndo, canRedo,
  };
}

export function slugify(s) {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
}
