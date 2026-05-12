// Tiny state hook for /projects. Keeps the list + status filter and
// exposes mutation helpers that optimistically update the cache so the
// list responds instantly. Mirrors the pattern used by useClients and
// useInvoices for consistency.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useProjects(initialStatus = '') {
  const [projects, setProjects] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [statusFilter, setStatusFilter] = useState(initialStatus);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
      const r = await api.get('/projects' + q);
      setProjects(r.projects || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  const create = async (payload) => {
    const r = await api.post('/projects', payload);
    if (r.project) {
      setProjects((p) => [r.project, ...p]);
    }
    return r.project;
  };

  const update = async (id, patch) => {
    // Optimistic — flip the row's shape immediately for snappy UI.
    setProjects((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x));
    try {
      const r = await api.patch('/projects/' + encodeURIComponent(id), patch);
      if (r.project) {
        setProjects((p) => p.map((x) => x.id === id ? r.project : x));
      }
      return r.project;
    } catch (e) {
      refresh();
      throw e;
    }
  };

  const remove = async (id) => {
    setProjects((p) => p.filter((x) => x.id !== id));
    try {
      await api.del('/projects/' + encodeURIComponent(id));
    } catch (e) {
      refresh();
      throw e;
    }
  };

  return {
    projects, loading, error,
    statusFilter, setStatusFilter,
    refresh, create, update, remove,
  };
}
