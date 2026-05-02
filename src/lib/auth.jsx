// Auth context — holds the logged-in user and exposes sign-in / sign-up / sign-out.
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    api.get('/auth/me')
      .then((r) => live && setUser(r.user))
      .catch(() => live && setUser(null))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const signIn = useCallback(async (email, password) => {
    const r = await api.post('/auth/login', { email, password });
    setUser(r.user);
    return r.user;
  }, []);

  // mode: 'owner' (default — creates a workspace) or 'client' (no workspace,
  // claims existing client records by email match).
  const signUp = useCallback(async (email, password, name, mode = 'owner') => {
    const r = await api.post('/auth/signup', { email, password, name, mode });
    setUser(r.user);
    return r;
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
  }, []);

  // Refresh the user (e.g. after email verification) so UI flips immediately.
  const refresh = useCallback(async () => {
    try {
      const r = await api.get('/auth/me');
      setUser(r.user);
      return r.user;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, signIn, signUp, signOut, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
