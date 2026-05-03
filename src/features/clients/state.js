// API-backed clients store. GET on mount, optimistic local updates with API write-through.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useClients() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/clients')
      .then((r) => live && setClients(r.clients || []))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

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
      if (fresh) setClients(fresh.clients || []);
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
    return r.clients;
  }, []);

  return { clients, loading, error, create, update, remove, refresh };
}
