// Helper-shell context: one /api/helper/me round trip shared by the
// schedule and account screens. Carries which business is selected (a
// helper can work for more than one), the staff record, and a `paused`
// flag when the owner's subscription has lapsed (the API answers 402).
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, setHelperWorkspace } from '../../lib/api.js';

const Ctx = createContext(null);
const WS_KEY = 'ivy_helper_ws';

function rememberedWorkspace() {
  try { return localStorage.getItem(WS_KEY) || null; } catch { return null; }
}

export function HelperProvider({ children }) {
  const [searchParams] = useSearchParams();
  const [workspaceId, setWorkspaceIdState] = useState(() => searchParams.get('ws') || rememberedWorkspace());
  const [me, setMe] = useState(null);
  const [paused, setPaused] = useState(null); // { businessName } when 402
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const setWorkspaceId = useCallback((id) => {
    setWorkspaceIdState(id);
    try { if (id) localStorage.setItem(WS_KEY, id); else localStorage.removeItem(WS_KEY); } catch { /* private mode */ }
  }, []);

  const load = useCallback(async (ws) => {
    setLoading(true);
    try {
      const q = ws ? `?workspaceId=${encodeURIComponent(ws)}` : '';
      const r = await api.get(`/helper/me${q}`);
      // Set the helper-mode header BEFORE the screens render with this
      // context: their own effects (schedule, clients) fire before the
      // provider's effect below would, and must already carry it.
      if (r?.business?.workspaceId) setHelperWorkspace(r.business.workspaceId);
      setMe(r);
      setPaused(null);
      setError(null);
      if (r?.business?.workspaceId && r.business.workspaceId !== ws) setWorkspaceId(r.business.workspaceId);
    } catch (e) {
      if (e.status === 402) {
        setPaused({ businessName: e.details?.businessName || null, message: e.details?.message || e.message });
        setMe(null);
        setError(null);
      } else if (e.status === 403 && ws) {
        // A remembered business we no longer help at: fall back to the first.
        setWorkspaceId(null);
        return load(null);
      } else {
        setError(e);
      }
    } finally {
      setLoading(false);
    }
  }, [setWorkspaceId]);

  useEffect(() => { load(workspaceId); }, [workspaceId, load]);

  // While the shell is mounted every API call names the business the
  // helper is acting on (X-Helper-Workspace). Cleared on unmount so the
  // owner/client views never send it.
  // Clear only on unmount. A dependency-driven cleanup would null the
  // header between renders, right before the child screens' effects fire.
  const resolvedWs = me?.business?.workspaceId || null;
  useEffect(() => { if (resolvedWs) setHelperWorkspace(resolvedWs); }, [resolvedWs]);
  useEffect(() => () => setHelperWorkspace(null), []);

  const value = useMemo(() => ({
    me, paused, error, loading, workspaceId,
    helps: me?.helps || [],
    permissions: me?.permissions || { schedule: false, clients: false, messages: false },
    switchBusiness: setWorkspaceId,
    refresh: () => load(workspaceId),
  }), [me, paused, error, loading, workspaceId, setWorkspaceId, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHelper() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useHelper must be inside <HelperProvider>');
  return v;
}
