// Website state — sourced from /api/website.
// Local edits update immediately; writes are debounced to the server.
//
// Multi-page model:
//   site.pages is the source of truth. Each page = { id, slug, title,
//   sections[], inNav }. The legacy `site.sections` field is kept in
//   sync as a mirror of the home page (slug='') so any code path that
//   still reads `sections` continues to work.
//
//   currentPageId tracks which page the editor is editing right now —
//   local-only state, not persisted.
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { api } from '../../lib/api.js';

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

// Debounced server write — every change is coalesced into a single PUT.
function useDebouncedPut(delay = 600) {
  const pendingRef = useRef(null);
  const timerRef   = useRef(null);
  const [error, setError]     = useState(null);
  const [saving, setSaving]   = useState(false);

  const flush = useCallback(async () => {
    if (!pendingRef.current) return;
    const body = pendingRef.current;
    pendingRef.current = null;
    setSaving(true);
    try {
      await api.put('/website', body);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }, []);

  const schedule = useCallback((body) => {
    pendingRef.current = body;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, delay);
  }, [delay, flush]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { schedule, flush, saving, error };
}

export function useWebsite() {
  const [site, setSite]       = useState(DEFAULT_SITE);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [currentPageId, setCurrentPageId] = useState(null);
  // True when the live site is published but the draft has edits not yet
  // pushed live (drives the "unpublished changes → Publish" cue).
  const [dirty, setDirty] = useState(false);
  const loadedRef = useRef(false);
  const { schedule, flush, saving, error: saveErr } = useDebouncedPut();

  // ── Undo / redo history ──────────────────────────────────────────
  // Snapshots stack up to 50 entries deep. Every mutation pushes the
  // PREVIOUS state to `past` and clears `future`. Undo pops `past` ⇒
  // restores site + pushes the current snapshot to `future`. Redo does
  // the inverse. Triggers exposed on the returned API as undo/redo +
  // canUndo/canRedo (driven off the ref via a tiny counter).
  const historyRef = useRef({ past: [], future: [] });
  const [historyTick, setHistoryTick] = useState(0);
  const HISTORY_MAX = 50;

  const pushHistory = useCallback((prev) => {
    const h = historyRef.current;
    h.past.push(prev);
    if (h.past.length > HISTORY_MAX) h.past.shift();
    h.future = [];
    setHistoryTick((t) => t + 1);
  }, []);

  useEffect(() => {
    let live = true;
    api.get('/website')
      .then((r) => {
        if (!live) return;
        const n = normalize(r.website);
        setSite(n);
        setDirty(!!r.website?.hasUnpublishedChanges);
        const home = n.pages.find((p) => p.slug === '') || n.pages[0];
        if (home) setCurrentPageId(home.id);
        loadedRef.current = true;
      })
      .catch((e) => live && setLoadErr(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
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

  const mutate = useCallback((updater) => {
    setSite((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      const home = next.pages.find((p) => p.slug === '') || next.pages[0];
      const synced = { ...next, sections: home ? home.sections : [] };
      if (loadedRef.current) {
        // Snapshot the OUTGOING state so undo can return to it. We
        // structure-clone via JSON because the state holds arbitrary
        // section data that we don't want to share-reference into the
        // history (a later edit shouldn't mutate a snapshot).
        pushHistory(JSON.parse(JSON.stringify(prev)));
        scheduleWrite(synced);
      }
      return synced;
    });
  }, [pushHistory, scheduleWrite]);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.past.length === 0) return;
    const prev = h.past.pop();
    // Capture current site so redo can return to it.
    setSite((cur) => {
      h.future.push(JSON.parse(JSON.stringify(cur)));
      if (h.future.length > HISTORY_MAX) h.future.shift();
      setHistoryTick((t) => t + 1);
      const home = prev.pages.find((p) => p.slug === '') || prev.pages[0];
      const synced = { ...prev, sections: home ? home.sections : [] };
      scheduleWrite(synced);
      return synced;
    });
  }, [scheduleWrite]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.future.length === 0) return;
    const next = h.future.pop();
    setSite((cur) => {
      h.past.push(JSON.parse(JSON.stringify(cur)));
      if (h.past.length > HISTORY_MAX) h.past.shift();
      setHistoryTick((t) => t + 1);
      const home = next.pages.find((p) => p.slug === '') || next.pages[0];
      const synced = { ...next, sections: home ? home.sections : [] };
      scheduleWrite(synced);
      return synced;
    });
  }, [scheduleWrite]);

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;
  // historyTick is consumed only to force a re-render when push/pop
  // happens; we don't read its value, but the dependency keeps callers
  // re-rendering when the buttons should change disabled state.
  void historyTick;

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
      const original = p.sections[i];
      const clone = {
        ...original,
        id: `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 999)}`,
        data: JSON.parse(JSON.stringify(original.data || {})),
        style: { ...(original.style || {}) },
      };
      const next = p.sections.slice();
      next.splice(i + 1, 0, clone);
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
      const i = p.sections.findIndex((sec) => sec.id === id);
      if (i < 0) return p;
      const next = p.sections.slice();
      const [item] = next.splice(i, 1);
      const clamped = Math.max(0, Math.min(next.length, targetIndex));
      next.splice(clamped, 0, item);
      return { ...p, sections: next };
    });
  }, [currentPage, updatePage]);

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
    setSite(DEFAULT_SITE);
    try {
      await api.put('/website', {
        handle: null, businessName: null, template: 'clean',
        sections: [], pages: [], customCss: null, fontPair: null,
        customDomain: null, launched: false,
        seoTitle: null, seoDescription: null, seoOgImage: null, faviconUrl: null,
      });
    }
    catch (e) { setLoadErr(e); }
  }, []);

  const publish = useCallback(async () => {
    await flush();
    const r = await api.post('/website/publish');
    setSite((s) => ({ ...s, launched: true, publishedAt: r.published_at }));
    setDirty(false); // draft is now the published snapshot
    return r;
  }, [flush]);

  return {
    site, loading, loadErr, saving, saveErr,
    hasUnpublishedChanges: dirty,
    currentPage, currentPageId, setCurrentPageId,
    addPage, removePage, renamePage, movePage, movePageTo,
    set, setSection, addSection, removeSection, moveSection, moveSectionTo, duplicateSection,
    reset, publish, flush,
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
