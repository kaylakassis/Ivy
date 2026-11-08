// API-backed clients store for the Clients screen, paged on the server.
//
// The screen loads one page (50) for the current tab + search and appends
// the next page on "Show more" (GET /api/clients?cursor=...). The tab
// counts and the analytics cards come from the server over the whole book
// (?summary=1), never from the rows that happen to be loaded. Writes are
// optimistic with API write-through, as before.
//
// GET /api/clients without ?cursor still returns the old list (up to
// 1000): iPhone 1.0.5 and the client pickers use it.
import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../lib/api.js';
import { hapticTap } from '../../lib/haptics.js';
import { saveSnapshot } from '../../lib/snapshot.js';

const PAGE = 50;

function listUrl({ tab, query, cursor, windows, withSummary }) {
  const p = new URLSearchParams();
  p.set('cursor', cursor || '');
  p.set('limit', String(PAGE));
  if (tab && tab !== 'all') p.set('filter', tab);
  if (query) p.set('q', query);
  if (withSummary) {
    p.set('summary', '1');
    p.set('window', String(windows.analyticsWindow));
    p.set('leadWindow', String(windows.leadWindow));
  }
  return `/clients?${p.toString()}`;
}

export function useClients({ tab = 'all', query = '', analyticsWindow = 30, leadWindow = 30 } = {}) {
  const [clients, setClients]   = useState([]);
  const [summary, setSummary]   = useState(null);
  const [total, setTotal]       = useState(null);
  const [loading, setLoading]   = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError]       = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Only the newest request may write the list (fast typing in search).
  const reqId = useRef(0);
  const windowsRef = useRef({ analyticsWindow, leadWindow });
  windowsRef.current = { analyticsWindow, leadWindow };
  const q = query.trim();

  const loadFirst = useCallback(async () => {
    const id = ++reqId.current;
    setListLoading(true);
    try {
      const r = await api.get(listUrl({ tab, query: q, cursor: '', windows: windowsRef.current, withSummary: true }));
      if (id !== reqId.current) return;
      setClients(r.clients || []);
      setNextCursor(r.nextCursor || null);
      setTotal(Number.isFinite(r.total) ? r.total : null);
      if (r.summary) setSummary(r.summary);
      setError(null);
    } catch (e) {
      if (id === reqId.current) setError(e);
    } finally {
      if (id === reqId.current) { setLoading(false); setListLoading(false); }
    }
  }, [tab, q]);

  // First page whenever the tab or the search changes (search waits for a
  // short pause in typing).
  useEffect(() => {
    const t = setTimeout(loadFirst, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadFirst, q]);

  // Changing an analytics window only re-asks for the numbers.
  const refreshSummary = useCallback(async () => {
    try {
      const w = windowsRef.current;
      const r = await api.get(`/clients?summary=only&window=${w.analyticsWindow}&leadWindow=${w.leadWindow}`);
      if (r.summary) setSummary(r.summary);
    } catch { /* keep the last numbers */ }
  }, []);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    refreshSummary();
  }, [analyticsWindow, leadWindow, refreshSummary]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const id = reqId.current;
    setLoadingMore(true);
    try {
      const r = await api.get(listUrl({ tab, query: q, cursor: nextCursor }));
      if (id !== reqId.current) return;
      setClients((prev) => {
        const have = new Set(prev.map((c) => c.id));
        return [...prev, ...(r.clients || []).filter((c) => !have.has(c.id))];
      });
      setNextCursor(r.nextCursor || null);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, tab, q]);

  // Returns the new client; `invite` ({ sent, reason } from the server,
  // null on an older API) rides along on the returned object so
  // the page can say whether the portal invite really went out.
  const create = useCallback(async (input) => {
    hapticTap();
    const r = await api.post('/clients', input);
    setClients((cs) => [r.client, ...cs]);
    setTotal((n) => (n == null ? n : n + 1));
    refreshSummary();
    return { ...r.client, invite: r.invite || null };
  }, [refreshSummary]);

  const update = useCallback(async (id, patch) => {
    setClients((cs) => cs.map((c) => c.id === id ? { ...c, ...patch } : c));
    try {
      const r = await api.patch('/clients/' + id, patch);
      setClients((cs) => cs.map((c) => c.id === id ? r.client : c));
      if ('stage' in patch || 'email' in patch) refreshSummary();
      return r.client;
    } catch (e) {
      // Revert by re-fetching the current page.
      loadFirst();
      throw e;
    }
  }, [loadFirst, refreshSummary]);

  const remove = useCallback(async (id) => {
    // Wait for the server to confirm BEFORE removing locally - otherwise a
    // failure leaves the row hidden in the UI but still in the DB, and the
    // next page load brings it back.
    await api.del('/clients/' + id);
    setClients((cs) => cs.filter((c) => c.id !== id));
    setTotal((n) => (n == null ? n : Math.max(0, n - 1)));
    refreshSummary();
  }, [refreshSummary]);

  const refresh = useCallback(async () => { await loadFirst(); }, [loadFirst]);

  // iPhone app: keep the essentials of the loaded book on the phone for use
  // without signal (the unfiltered list only, so a search never narrows it).
  useEffect(() => {
    if (loading || tab !== 'all' || q || !clients.length) return;
    saveSnapshot('clients', clients);
  }, [clients, loading, tab, q]);

  return {
    clients, summary, total, loading, listLoading, error, create, update, remove, refresh,
    hasMore: !!nextCursor, loadMore, loadingMore,
  };
}

// The full list (as before, up to 1000) for the pickers that choose
// "which client" (merge, folder owner). Fetched only while one is open.
export function usePickerClients(active) {
  const [list, setList] = useState(null);
  useEffect(() => {
    if (!active || list) return undefined;
    let live = true;
    api.get('/clients').then((r) => { if (live) setList(r.clients || []); }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, [active, list]);
  return list;
}
