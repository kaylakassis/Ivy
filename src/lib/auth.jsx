// Auth context - holds the logged-in user and exposes sign-in / sign-up / sign-out.
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { api } from './api.js';
import { isNative } from './platform.js';
import { setNativeAuthToken, clearNativeAuthToken } from './nativeAuth.js';
import { clearMeCache, forgetLanding } from './landing.js';
import { clearDeviceCache, clearSiteHistory, readCache, writeCache } from './deviceCache.js';
import { clearOfflineData } from './offlineData.js';
import { logOutIap } from './iap.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from './legal.js';

const Ctx = createContext(null);

// Local hint that a session probably exists on this browser. RootRouter
// reads it to decide whether a cold "/" load should optimistically paint
// the marketing home (no hint → almost certainly signed out) instead of a
// blank "Loading…" while /auth/me round-trips. UX only - the server
// session cookie remains the sole source of truth for auth.
function stampSessionHint(signedIn) {
  try {
    if (signedIn) localStorage.setItem('ivy_signed_in', '1');
    else localStorage.removeItem('ivy_signed_in');
  } catch { /* private mode */ }
}

export function AuthProvider({ children }) {
  const [user, setUser]                 = useState(null);
  const [impersonating, setImpersonating] = useState(null);
  const [terms, setTerms]               = useState(null);
  const [privacy, setPrivacy]           = useState(null);
  const [loading, setLoading]           = useState(true);

  useEffect(() => {
    let live = true;
    api.get('/auth/me')
      .then((r) => {
        if (!live) return;
        setUser(r.user);
        setImpersonating(r.impersonating || null);
        setTerms(r.terms || null); setPrivacy(r.privacy || null);
        stampSessionHint(!!r.user);
        // iPhone app: the signed-in user as /auth/me describes them, for a
        // launch with no signal (cleared with the rest of the device cache
        // at sign-out).
        if (r.user) writeCache('auth_user', r.user);
      })
      .catch((e) => {
        if (!live) return;
        // iPhone app with no signal: the session could not be checked, so
        // keep the owner who was signed in on this phone (from the last
        // /me the device kept) and open on the saved copy, instead of the
        // welcome screen. The server still decides every request.
        const cached = e?.status === 0 && isNative() ? (readCache('auth_user') || readCache('me')?.user || null) : null;
        if (cached?.id) { setUser(cached); stampSessionHint(true); return; }
        setUser(null); stampSessionHint(false);
      })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  // After a sign-in, load the Terms / Privacy state the same way a page load
  // does. Without this, someone who signs in (rather than reopening the app)
  // never saw the "We updated our Privacy Policy" notice until they reloaded.
  const loadLegalState = useCallback(() => {
    api.get('/auth/me')
      .then((r) => { setTerms(r.terms || null); setPrivacy(r.privacy || null); })
      .catch(() => {});
  }, []);

  // Holds the native-only mfa token between /auth/login and the challenge.
  // (Web carries it in an httpOnly cookie the server sets on login.)
  const mfaTokenRef = useRef(null);
  // What the code step should offer: { methods: ['totp'|'email'], emailSent,
  // email (masked), emailError, retryAfterSeconds }. null = unknown (e.g. the
  // page was reloaded on /signin?mfa=1), and the step offers both.
  const [mfaInfo, setMfaInfo] = useState(null);
  const pickMfaInfo = (r) => (r ? {
    methods: Array.isArray(r.mfaMethods) ? r.mfaMethods : null,
    emailSent: !!r.mfaEmailSent,
    email: r.mfaEmail || null,
    emailError: r.mfaEmailError || null,
    retryAfterSeconds: r.mfaRetryAfterSeconds || null,
  } : null);

  const signIn = useCallback(async (email, password) => {
    const r = await api.post('/auth/login', { email, password });
    // Native shell: cookies do not survive the cross-origin hop, so the
    // server also returns the session token. Keep it on the device.
    if (isNative() && r?.token) await setNativeAuthToken(r.token);
    if (r.mfaRequired) {
      // Password OK but this account has 2FA on — hold here; the caller shows a
      // code screen and calls mfaChallenge().
      mfaTokenRef.current = r.mfaToken || null;
      const info = pickMfaInfo(r);
      setMfaInfo(info);
      return { mfaRequired: true, ...info };
    }
    clearMeCache(); clearDeviceCache();
    setUser(r.user);
    stampSessionHint(true);
    loadLegalState();
    return r.user;
  }, [loadLegalState]);

  // A password reset on a 2FA account ends at the same code step as login.
  // The reset page hands over the native-only token here before routing to
  // the sign-in screen with ?mfa=1.
  // `response` is the whole reset/restore reply, so the code step knows
  // whether a code was already emailed.
  const beginMfa = useCallback((mfaToken, response = null) => {
    mfaTokenRef.current = mfaToken || null;
    setMfaInfo(pickMfaInfo(response));
  }, []);

  // "Send a new code" / "Email me a code instead" on the code step. Throws
  // the server's error (429 carries retryAfterSeconds in err.details).
  const mfaSendEmailCode = useCallback(async () => {
    const r = await api.post('/auth/mfa/send-code', {
      ...(mfaTokenRef.current ? { mfaToken: mfaTokenRef.current } : {}),
    });
    setMfaInfo((prev) => ({ ...(prev || { methods: null }), emailSent: true, email: r.email || prev?.email || null, emailError: null }));
    return r;
  }, []);

  // Second factor: exchange a 6-digit code (authenticator app or emailed) or
  // a backup code for a real session.
  const mfaChallenge = useCallback(async (code) => {
    const r = await api.post('/auth/totp/challenge', {
      code,
      ...(mfaTokenRef.current ? { mfaToken: mfaTokenRef.current } : {}),
    });
    if (isNative() && r?.token) await setNativeAuthToken(r.token);
    mfaTokenRef.current = null;
    setMfaInfo(null);
    clearMeCache(); clearDeviceCache();
    setUser(r.user);
    stampSessionHint(true);
    loadLegalState();
    return r.user;
  }, [loadLegalState]);

  // mode: 'owner' (default - creates a workspace) or 'client' (no workspace,
  // claims existing client records by email match).
  // ref: optional affiliate code preserved from ?ref=CODE on the signup URL.
  // The Terms version is pinned at compile time on the client and
  // re-validated server-side; passing it explicitly creates an audit
  // trail tying the bytes the user actually saw to the row we
  // record.
  const signUp = useCallback(async (email, password, name, mode = 'owner', ref = null, consent = {}) => {
    const r = await api.post('/auth/signup', {
      email, password, name, mode, ref,
      // Email consent boxes on the sign-up form: account and service
      // emails (required) and marketing (optional).
      acceptedAccountEmails: consent.accountEmails === true,
      marketingOptIn: consent.marketing === true,
      // The AuthPage checkbox says "I agree to the Terms and Privacy
      // Policy" - one click covers both. Send both versions so the
      // server can record an immutable acceptance row per document.
      acceptedTermsVersion: CURRENT_TERMS_VERSION,
      acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
    });
    // Native shell: cookies do not survive the cross-origin hop, so the
    // server also returns the session token. Keep it on the device.
    if (isNative() && r?.token) await setNativeAuthToken(r.token);
    // A brand-new account must ALWAYS be eligible for onboarding. The
    // onboarding-skip flag is per-browser, not per-account, so a stale one
    // left by a PREVIOUS account on this device (owner deleted + re-signed
    // up, or a shared device) would make RoleRouter wrongly bypass the
    // wizard. Clear it at account creation so a fresh owner always onboards.
    try { localStorage.removeItem('ivy_skip_onboarding_until'); } catch { /* private mode */ }
    clearMeCache(); clearDeviceCache();
    setUser(r.user);
    stampSessionHint(true);
    return r;
  }, []);

  const signOut = useCallback(async () => {
    // Release this device's notifications from the account first, while
    // the session is still valid: otherwise the next person to sign in on
    // this phone or browser would keep getting this account's pushes (and
    // their own registration would be refused as "token in use"). Never
    // throws and never waits more than a few seconds.
    // push.js is imported here on demand so the main bundle, which every
    // marketing visitor downloads, does not carry it; the signed-in shells
    // already loaded it, so this resolves at once.
    await import('./push.js').then((m) => m.detachPushForSignOut()).catch(() => {});
    // Always clear local auth state even if the network call fails, so the
    // user is never stuck "logged in" with no feedback when offline / on a 5xx.
    try { await api.post('/auth/logout'); }
    finally {
      // Native: forget the token stored on the device, network or not.
      if (isNative()) await clearNativeAuthToken().catch(() => {});
      // Drop the RevenueCat customer as well, so the next account on this
      // device cannot inherit this owner's subscription.
      await logOutIap().catch(() => {});
      setUser(null); setImpersonating(null); setTerms(null); setPrivacy(null);
      stampSessionHint(false);
      // Forget this account's role answer and remembered landing so the next
      // sign-in on this device starts from a clean slate.
      clearMeCache(); forgetLanding(); clearDeviceCache(); clearSiteHistory();
      // The iPhone app's offline copy (today's schedule, clients, recent
      // messages) and anything queued while offline go with the account.
      await clearOfflineData();
      // Don't let a per-browser onboarding-skip flag leak into whoever signs
      // in next on this device (e.g. after an account deletion).
      try { localStorage.removeItem('ivy_skip_onboarding_until'); } catch { /* private mode */ }
    }
  }, []);

  // Refresh the user (e.g. after email verification) so UI flips immediately.
  const refresh = useCallback(async () => {
    try {
      const r = await api.get('/auth/me');
      setUser(r.user);
      setImpersonating(r.impersonating || null);
      setTerms(r.terms || null); setPrivacy(r.privacy || null);
      // Local session hint: lets RootRouter render the marketing home
      // instantly for cold signed-out visitors (no hint) instead of a
      // blank "Loading…" while /auth/me round-trips. Purely a UX hint -
      // never trusted for auth decisions.
      try {
        if (r.user) localStorage.setItem('ivy_signed_in', '1');
        else localStorage.removeItem('ivy_signed_in');
      } catch { /* private mode */ }
      return r.user;
    } catch (e) {
      // No signal: not a sign-out. Keep whoever is signed in.
      if (e?.status === 0) return user;
      setUser(null);
      setImpersonating(null);
      setTerms(null); setPrivacy(null);
      return null;
    }
  }, [user]);

  // Auto-detect email verification that happens OUTSIDE this tab - the
  // verify link usually opens in a new tab (or gets clicked on the
  // user's phone), so this tab's user snapshot goes stale and the
  // "Confirm your email" banner never leaves. While the signed-in user
  // is unverified: re-check on focus/visibility, listen for the
  // cross-tab localStorage beacon the verify page writes, and poll
  // gently as a cross-device fallback. Tears down as soon as the user
  // is verified (or signed out).
  useEffect(() => {
    if (!user || user.email_verified_at) return undefined;
    const check = () => { refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    const onStorage = (e) => { if (e.key === 'ivy_email_verified_beacon') check(); };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', onStorage);
    const iv = setInterval(check, 45000);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
      clearInterval(iv);
    };
  }, [user?.id, user?.email_verified_at, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Records the user's acceptance of the current Terms version.
  // Server gates by version, then writes both an immutable
  // legal_acceptances row and the denormalized users.terms_version
  // snapshot. After it returns, refresh /api/auth/me so the
  // mustAcceptTerms flag flips off.
  const acceptCurrentTerms = useCallback(async () => {
    await api.post('/me/accept-terms', { version: CURRENT_TERMS_VERSION });
    await refresh();
  }, [refresh]);

  // Acknowledges the current Privacy Policy after an update notice.
  const acknowledgePrivacy = useCallback(async () => {
    await api.post('/me/accept-terms', { document: 'privacy', version: CURRENT_PRIVACY_VERSION });
    await refresh();
  }, [refresh]);

  return (
    <Ctx.Provider value={{
      user, loading, signIn, mfaChallenge, beginMfa, mfaInfo, mfaSendEmailCode, signUp, signOut, refresh, impersonating,
      terms,
      mustAcceptTerms: !!(user && terms?.needsAcceptance),
      privacy,
      privacyUpdatePending: !!(user && privacy?.needsAcknowledgement && !terms?.needsAcceptance),
      acknowledgePrivacy,
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
