// API-backed store for time tracking entries + the active timer.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useTimeEntries() {
  const [entries, setEntries] = useState([]);
  const [defaultRate, setDefaultRate] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const refresh = useCallback(async () => {
    const r = await api.get('/time-entries');
    setEntries(r.entries || []);
    setDefaultRate(Number(r.defaultHourlyRate || 0));
  }, []);

  useEffect(() => {
    let live = true;
    refresh()
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [refresh]);

  const start = useCallback(async (input) => {
    const r = await api.post('/time-entries', input || {});
    // Starting a new entry stops the previous running one server-side.
    // Re-fetch so the list reflects both updates.
    await refresh();
    return r.entry;
  }, [refresh]);

  const stop = useCallback(async () => {
    const r = await api.post('/time-entries/stop', {});
    await refresh();
    return r.entry;
  }, [refresh]);

  const update = useCallback(async (id, patch) => {
    const r = await api.patch('/time-entries/' + id, patch);
    setEntries((xs) => xs.map((e) => e.id === id ? r.entry : e));
    return r.entry;
  }, []);

  const remove = useCallback(async (id) => {
    await api.del('/time-entries/' + id);
    setEntries((xs) => xs.filter((e) => e.id !== id));
  }, []);

  const bill = useCallback(async (entryIds, clientId) => {
    const r = await api.post('/time-entries/bill', { entryIds, clientId });
    await refresh();
    return r.invoice;
  }, [refresh]);

  return { entries, defaultRate, loading, error, refresh, start, stop, update, remove, bill };
}
