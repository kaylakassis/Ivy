// Decides what to render at "/" based on auth state:
//   • Logged-out  → MarketingHome
//   • Logged-in owner (or has both roles) → Navigate to /dashboard
//   • Logged-in client-only → Navigate to /me
//
// Skips a network call when /api/me is already resolved by the auth provider
// (useAuth gives us .user; that's enough to decide whether to even attempt a
// role check). For role detection we hit /api/me here once on first load.
import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import MarketingHome from './site/SiteHome.jsx';

export default function RootRouter() {
  const { user, loading: authLoading } = useAuth();
  const [decision, setDecision] = useState(null); // 'business' | 'client' | null

  useEffect(() => {
    if (!user) { setDecision(null); return; }
    let live = true;
    api.get('/me')
      .then((r) => {
        if (!live) return;
        // Owner who hasn't finished onboarding → wizard, UNLESS they used the
        // "Save & exit" escape hatch (ivy_skip_onboarding_until), which
        // RoleRouter also honors. Without this, navigating to "/" after
        // skipping bounces them back into onboarding — the loop the flag prevents.
        let skipUntil = 0;
        try { skipUntil = Number(localStorage.getItem('ivy_skip_onboarding_until')) || 0; } catch { /* ignore */ }
        const skipping = skipUntil > Date.now();
        if (r.isOwner && !r.onboardedAt && !skipping) { setDecision('onboarding'); return; }
        if (r.isOwner) setDecision('business');
        else if (r.isClient) setDecision('client');
        else setDecision('business'); // workspace got auto-created on signup
      })
      .catch(() => live && setDecision('business'));
    return () => { live = false; };
  }, [user]);

  // Logged-out → always the marketing home. The controlled-launch waitlist
  // does NOT take over "/"; it only gates the auth entry points (/signin,
  // /signup via EarlyAccessGate), so a visitor sees the normal marketing
  // site and only meets the waitlist when they click "Start free trial" /
  // "Sign up". Keeps the home page public and skips a status round-trip here.
  if (!authLoading && !user) {
    return <MarketingHome/>;
  }

  // While the initial /auth/me is still in flight: cold visitors (no local
  // session hint) get the marketing home painted IMMEDIATELY - a paid-
  // traffic phone visitor used to stare at a blank "Loading…" for a full
  // network round-trip before the hero appeared. If they turn out to be
  // signed in after all, the redirect below kicks in a moment later.
  let hasSessionHint = false;
  try { hasSessionHint = localStorage.getItem('ivy_signed_in') === '1'; } catch { /* private mode */ }
  if (authLoading && !user && !hasSessionHint) {
    return <MarketingHome/>;
  }

  // Likely-signed-in (hint present) → keep the neutral loading frame until
  // we know where to land, because flashing marketing at an active user
  // would feel like a sign-out bug.
  if (authLoading || (user && !decision)) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)', fontSize: 13, background: 'var(--page)',
      }}>
        Loading…
      </div>
    );
  }

  // Logged-in: bounce to the right surface.
  if (decision === 'onboarding') return <Navigate to={{ pathname: '/onboarding', search: window.location.search }} replace/>;
  if (decision === 'client')     return <Navigate to={{ pathname: '/me', search: window.location.search }} replace/>;
  return <Navigate to={{ pathname: '/dashboard', search: window.location.search }} replace/>;
}
