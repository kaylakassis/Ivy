// Client-portal context - fetches /api/me once, exposes the result to all
// client-portal screens. Memberships, isOwner, isClient, summary are all
// here so we don't refetch on every route change.
import { useEffect, useState, useCallback, createContext, useContext } from 'react';
import { api } from '../../lib/api.js';

const Ctx = createContext(null);

export function ClientPortalProvider({ children }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get('/me');
      setData(r);
      setError(null);
      return r;
    } catch (e) {
      setError(e);
      throw e;
    }
  }, []);

  useEffect(() => {
    let live = true;
    api.get('/me')
      .then((r) => live && setData(r))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  return (
    <Ctx.Provider value={{ data, loading, error, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useClientPortal() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useClientPortal must be inside <ClientPortalProvider>');
  return v;
}
