// Folders (stored as "projects" on the server): a named bundle of one
// client's or one job's bookings, invoices, quotes and documents.
// Same optimistic pattern as useClients.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export const FOLDER_STATUS = {
  planning:  { label: 'Planning',  color: 'var(--muted)' },
  active:    { label: 'Active',    color: 'var(--ok)' },
  on_hold:   { label: 'On hold',   color: 'var(--warn)' },
  completed: { label: 'Completed', color: 'var(--muted-2)' },
  cancelled: { label: 'Cancelled', color: 'var(--danger)' },
};

export function useFolders() {
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const r = await api.get('/projects');
      setFolders(r.projects || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = async (payload) => {
    const r = await api.post('/projects', payload);
    if (r.project) setFolders((p) => [r.project, ...p]);
    return r.project;
  };

  const update = async (id, patch) => {
    setFolders((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x));
    try {
      const r = await api.patch('/projects/' + encodeURIComponent(id), patch);
      if (r.project) setFolders((p) => p.map((x) => x.id === id ? { ...x, ...r.project } : x));
      return r.project;
    } catch (e) {
      refresh();
      throw e;
    }
  };

  const remove = async (id) => {
    setFolders((p) => p.filter((x) => x.id !== id));
    try {
      await api.del('/projects/' + encodeURIComponent(id));
    } catch (e) {
      refresh();
      throw e;
    }
  };

  return { folders, loading, error, refresh, create, update, remove };
}
