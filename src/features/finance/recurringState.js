// API-backed store for recurring invoice schedules.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useRecurring() {
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/recurring-invoices')
      .then((r) => live && setSchedules(r.schedules || []))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const create = useCallback(async (input) => {
    const r = await api.post('/recurring-invoices', input);
    setSchedules((xs) => [r.schedule, ...xs]);
    return r.schedule;
  }, []);

  const update = useCallback(async (id, patch) => {
    const r = await api.patch('/recurring-invoices/' + id, patch);
    setSchedules((xs) => xs.map((s) => s.id === id ? r.schedule : s));
    return r.schedule;
  }, []);

  const remove = useCallback(async (id) => {
    await api.del('/recurring-invoices/' + id);
    setSchedules((xs) => xs.filter((s) => s.id !== id));
  }, []);

  const runNow = useCallback(async (id) => {
    const r = await api.post('/recurring-invoices/run-now', { id });
    setSchedules((xs) => xs.map((s) => s.id === id ? r.schedule : s));
    return r;
  }, []);

  return { schedules, loading, error, create, update, remove, runNow };
}
