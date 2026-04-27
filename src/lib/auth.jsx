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

  const signUp = useCallback(async (email, password, name) => {
    const r = await api.post('/auth/signup', { email, password, name });
    setUser(r.user);
    return r.user;
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, signIn, signUp, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
