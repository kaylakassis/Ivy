// API-backed clients store. GET on mount, optimistic local updates with API write-through.
//
// Pagination support added with the scaling work: the server now caps
// at 1000 rows per request and reports hasMore + nextOffset. The hook
// exposes loadMore() so the consuming page can append the next batch.
// Default first page (1000 rows) covers the overwhelming majority of
// workspaces without a "Load more" button ever appearing.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useClients() {
  const [clients, setClients]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [hasMore, setHasMore]   = useState(false);
  const [nextOffset, setNextOffset] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let live = true;
    api.get('/clients')
      .then((r) => {
        if (!live) return;
        setClients(r.clients || []);
        setHasMore(!!r.hasMore);
        setNextOffset(r.nextOffset ?? null);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const loadMore = useCallback(async () => {
    if (!hasMore || nextOffset == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.get(`/clients?offset=${nextOffset}`);
      // De-dup defensively in case a create/update raced — we never
      // want a duplicate row appearing twice on the page.
      const existingIds = new Set(clients.map((c) => c.id));
      const fresh = (r.clients || []).filter((c) => !existingIds.has(c.id));
      setClients((prev) => [...prev, ...fresh]);
      setHasMore(!!r.hasMore);
      setNextOffset(r.nextOffset ?? null);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, nextOffset, loadingMore, clients]);

  const create = useCallback(async (input) => {
    const r = await api.post('/clients', input);
    setClients((cs) => [r.client, ...cs]);
    return r.client;
  }, []);

  const update = useCallback(async (id, patch) => {
    setClients((cs) => cs.map((c) => c.id === id ? { ...c, ...patch } : c));
    try {
      const r = await api.patch('/clients/' + id, patch);
      setClients((cs) => cs.map((c) => c.id === id ? r.client : c));
      return r.client;
    } catch (e) {
      // Revert by re-fetching
      const fresh = await api.get('/clients').catch(() => null);
      if (fresh) {
        setClients(fresh.clients || []);
        setHasMore(!!fresh.hasMore);
        setNextOffset(fresh.nextOffset ?? null);
      }
      throw e;
    }
  }, []);

  const remove = useCallback(async (id) => {
    // Wait for the server to confirm BEFORE removing locally — otherwise a
    // failure leaves the row hidden in the UI but still in the DB, and the
    // next page load brings it back.
    await api.del('/clients/' + id);
    setClients((cs) => cs.filter((c) => c.id !== id));
  }, []);

  const refresh = useCallback(async () => {
    const r = await api.get('/clients');
    setClients(r.clients || []);
    setHasMore(!!r.hasMore);
    setNextOffset(r.nextOffset ?? null);
    return r.clients;
  }, []);

  return { clients, loading, error, create, update, remove, refresh,
           hasMore, loadMore, loadingMore };
}
