// Auth context - holds the logged-in user and exposes sign-in / sign-up / sign-out.
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from './legal.js';

const Ctx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]                 = useState(null);
  const [impersonating, setImpersonating] = useState(null);
  const [terms, setTerms]               = useState(null);
  const [loading, setLoading]           = useState(true);

  useEffect(() => {
    let live = true;
    api.get('/auth/me')
      .then((r) => {
        if (!live) return;
        setUser(r.user);
        setImpersonating(r.impersonating || null);
        setTerms(r.terms || null);
      })
      .catch(() => live && setUser(null))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  // Holds the native-only mfa token between /auth/login and the challenge.
  // (Web carries it in an httpOnly cookie the server sets on login.)
  const mfaTokenRef = useRef(null);

  const signIn = useCallback(async (email, password) => {
    const r = await api.post('/auth/login', { email, password });
    if (r.mfaRequired) {
      // Password OK but this account has 2FA on — hold here; the caller shows a
      // code screen and calls mfaChallenge().
      mfaTokenRef.current = r.mfaToken || null;
      return { mfaRequired: true };
    }
    setUser(r.user);
    return r.user;
  }, []);

  // Second factor: exchange a 6-digit TOTP or a backup code for a real session.
  const mfaChallenge = useCallback(async (code) => {
    const r = await api.post('/auth/totp/challenge', {
      code,
      ...(mfaTokenRef.current ? { mfaToken: mfaTokenRef.current } : {}),
    });
    mfaTokenRef.current = null;
    setUser(r.user);
    return r.user;
  }, []);

  // mode: 'owner' (default - creates a workspace) or 'client' (no workspace,
  // claims existing client records by email match).
  // ref: optional affiliate code preserved from ?ref=CODE on the signup URL.
  // The Terms version is pinned at compile time on the client and
  // re-validated server-side; passing it explicitly creates an audit
  // trail tying the bytes the user actually saw to the row we
  // record.
  const signUp = useCallback(async (email, password, name, mode = 'owner', ref = null) => {
    const r = await api.post('/auth/signup', {
      email, password, name, mode, ref,
      // The AuthPage checkbox says "I agree to the Terms and Privacy
      // Policy" - one click covers both. Send both versions so the
      // server can record an immutable acceptance row per document.
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
    });
    setUser(r.user);
    return r;
  }, []);

  const signOut = useCallback(async () => {
    // Always clear local auth state even if the network call fails, so the
    // user is never stuck "logged in" with no feedback when offline / on a 5xx.
    try { await api.post('/auth/logout'); }
    finally { setUser(null); setImpersonating(null); setTerms(null); }
  }, []);

  // Refresh the user (e.g. after email verification) so UI flips immediately.
  const refresh = useCallback(async () => {
    try {
      const r = await api.get('/auth/me');
      setUser(r.user);
      setImpersonating(r.impersonating || null);
      setTerms(r.terms || null);
      return r.user;
    } catch {
      setUser(null);
      setImpersonating(null);
      setTerms(null);
      return null;
    }
  }, []);

  // Records the user's acceptance of the current Terms version.
  // Server gates by version, then writes both an immutable
  // legal_acceptances row and the denormalized users.terms_version
  // snapshot. After it returns, refresh /api/auth/me so the
  // mustAcceptTerms flag flips off.
  const acceptCurrentTerms = useCallback(async () => {
    await api.post('/me/accept-terms', { version: CURRENT_TERMS_VERSION });
    await refresh();
  }, [refresh]);

  return (
    <Ctx.Provider value={{
      user, loading, signIn, mfaChallenge, signUp, signOut, refresh, impersonating,
      terms,
      mustAcceptTerms: !!(user && terms?.needsAcceptance),
      acceptCurrentTerms,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
