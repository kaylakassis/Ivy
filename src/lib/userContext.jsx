// Shared user-context provider for routes outside the client portal
// (AppShell, onboarding, account pages). Single fetch of /api/me, exposed
// via the useUserContext() hook so the floating ViewToggle, Paywall, and
// any other consumer share one round-trip.
//
// The /me/* portal already has its own ClientPortalProvider; both expose
// the same `ctx` shape (user, isOwner, isClient, subscription, memberships)
// so a component like ViewToggle can take ctx as a prop and not care which
// provider supplied it.
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const Ctx = createContext({ ctx: null, loading: true, error: null, refresh: () => {} });

export function UserContextProvider({ children }) {
  const [ctx, setCtx] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    const r = await api.get('/me');
    setCtx(r);
    return r;
  }, []);

  useEffect(() => {
    let live = true;
    api.get('/me')
      .then((r) => live && setCtx(r))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  return <Ctx.Provider value={{ ctx, loading, error, refresh }}>{children}</Ctx.Provider>;
}

export function useUserContext() {
  return useContext(Ctx);
}
