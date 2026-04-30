// API-backed documents store.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useDocuments() {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/documents')
      .then((r) => live && setDocuments(r.documents || []))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const refresh = useCallback(async () => {
    const r = await api.get('/documents');
    setDocuments(r.documents || []);
    return r.documents;
  }, []);

  const create = useCallback(async (input) => {
    const r = await api.post('/documents', input);
    setDocuments((ds) => [r.document, ...ds]);
    return r.document;
  }, []);

  const update = useCallback(async (id, patch) => {
    const r = await api.patch('/documents/' + id, patch);
    setDocuments((ds) => ds.map((d) => d.id === id ? r.document : d));
    return r.document;
  }, []);

  const remove = useCallback(async (id) => {
    await api.del('/documents/' + id);
    setDocuments((ds) => ds.filter((d) => d.id !== id));
  }, []);

  const send = useCallback(async (id, clientId) => {
    const r = await api.post('/documents/send', { id, clientId });
    setDocuments((ds) => ds.map((d) => d.id === id ? r.document : d));
    return r.document;
  }, []);

  const voidDoc = useCallback(async (id) => {
    const r = await api.post('/documents/void', { id });
    setDocuments((ds) => ds.map((d) => d.id === id ? r.document : d));
    return r.document;
  }, []);

  return { documents, loading, error, refresh, create, update, remove, send, void: voidDoc };
}
