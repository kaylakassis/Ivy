// Website state — sourced from /api/website.
// Local edits update immediately; writes are debounced to the server.
import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../lib/api.js';

export const DEFAULT_SITE = {
  launched: false,
  businessName: '',
  handle: '',
  template: 'clean',
  customDomain: '',
  publishedAt: null,
  sections: [],
};

function normalize(w) {
  if (!w) return DEFAULT_SITE;
  return {
    launched:     !!w.launched,
    businessName: w.businessName || '',
    handle:       w.handle || '',
    template:     w.template || 'clean',
    customDomain: w.customDomain || '',
    publishedAt:  w.publishedAt || null,
    sections:     Array.isArray(w.sections) ? w.sections : [],
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
  const loadedRef = useRef(false);
  const { schedule, flush, saving, error: saveErr } = useDebouncedPut();

  // Initial load.
  useEffect(() => {
    let live = true;
    api.get('/website')
      .then((r) => {
        if (!live) return;
        setSite(normalize(r.website));
        loadedRef.current = true;
      })
      .catch((e) => live && setLoadErr(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  // Any time the site changes after load, queue a PUT.
  // We send only the editable subset (publishedAt is server-managed).
  const scheduleWrite = useCallback((next) => {
    schedule({
      handle:        next.handle,
      businessName:  next.businessName,
      template:      next.template,
      sections:      next.sections,
      customDomain:  next.customDomain,
      launched:      next.launched,
    });
  }, [schedule]);

  const mutate = useCallback((updater) => {
    setSite((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      if (loadedRef.current) scheduleWrite(next);
      return next;
    });
  }, [scheduleWrite]);

  const set = useCallback((patch) => mutate(patch), [mutate]);

  const setSection = useCallback((id, patch) => mutate((s) => ({
    ...s,
    sections: s.sections.map((sec) =>
      sec.id === id ? { ...sec, ...patch, data: { ...sec.data, ...(patch.data || {}) } } : sec,
    ),
  })), [mutate]);

  const addSection = useCallback((sec) => mutate((s) => ({
    ...s, sections: [...s.sections, sec],
  })), [mutate]);

  const removeSection = useCallback((id) => mutate((s) => ({
    ...s, sections: s.sections.filter((sec) => sec.id !== id),
  })), [mutate]);

  const moveSection = useCallback((id, dir) => mutate((s) => {
    const i = s.sections.findIndex((sec) => sec.id === id);
    if (i < 0) return s;
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= s.sections.length) return s;
    const next = s.sections.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return { ...s, sections: next };
  }), [mutate]);

  const reset = useCallback(async () => {
    // Clear to defaults, then write through.
    setSite(DEFAULT_SITE);
    try { await api.put('/website', { handle: null, businessName: null, template: 'clean', sections: [], customDomain: null, launched: false }); }
    catch (e) { setLoadErr(e); }
  }, []);

  const publish = useCallback(async () => {
    await flush();
    const r = await api.post('/website/publish');
    setSite((s) => ({ ...s, launched: true, publishedAt: r.published_at }));
    return r;
  }, [flush]);

  return {
    site, loading, loadErr, saving, saveErr,
    set, setSection, addSection, removeSection, moveSection,
    reset, publish, flush,
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
