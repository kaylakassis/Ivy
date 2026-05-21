// Email campaigns store. List + draft CRUD + send / test-send + a live
// recipient-count preview for the composer.
import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useCampaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try { const r = await api.get('/campaigns'); setCampaigns(r.campaigns || []); setError(null); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (input) => {
    const r = await api.post('/campaigns', input);
    setCampaigns((c) => [r.campaign, ...c]);
    return r.campaign;
  }, []);

  const update = useCallback(async (id, patch) => {
    const r = await api.patch(`/campaigns/${id}`, patch);
    setCampaigns((c) => c.map((x) => (x.id === id ? r.campaign : x)));
    return r.campaign;
  }, []);

  const remove = useCallback(async (id) => {
    await api.del(`/campaigns/${id}`);
    setCampaigns((c) => c.filter((x) => x.id !== id));
  }, []);

  const send = useCallback(async (id) => {
    const r = await api.post(`/campaigns/${id}/send`, {});
    if (r.campaign) setCampaigns((c) => c.map((x) => (x.id === id ? r.campaign : x)));
    return r;
  }, []);

  const sendTest = useCallback(async (id) => api.post(`/campaigns/${id}/send`, { test: true }), []);

  const previewCount = useCallback(async (audience) => {
    const r = await api.get(`/campaigns?previewAudience=${encodeURIComponent(audience)}`);
    return r.count;
  }, []);

  return { campaigns, loading, error, refresh, create, update, remove, send, sendTest, previewCount };
}
