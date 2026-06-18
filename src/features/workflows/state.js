// State hook for /workflows. List + optimistic CRUD + per-workflow
// detail fetch (includes recent runs for debugging).
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

export function useWorkflows() {
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await api.get('/workflows');
      setWorkflows(r.workflows || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = async (payload) => {
    const r = await api.post('/workflows', payload);
    if (r.workflow) setWorkflows((p) => [r.workflow, ...p]);
    return r.workflow;
  };

  const update = async (id, patch) => {
    // Optimistic - only toggle enabled is hot-path; full edits do
    // an optimistic flip + refresh to pull the canonical row.
    setWorkflows((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x));
    try {
      const r = await api.patch('/workflows/' + encodeURIComponent(id), patch);
      if (r.workflow) {
        setWorkflows((p) => p.map((x) => x.id === id ? r.workflow : x));
      }
      return r.workflow;
    } catch (e) {
      refresh();
      throw e;
    }
  };

  const remove = async (id) => {
    setWorkflows((p) => p.filter((x) => x.id !== id));
    try { await api.del('/workflows/' + encodeURIComponent(id)); }
    catch (e) { refresh(); throw e; }
  };

  return { workflows, loading, error, refresh, create, update, remove };
}
