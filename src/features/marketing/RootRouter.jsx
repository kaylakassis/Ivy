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
import MarketingHome from './MarketingHome.jsx';
import WaitlistPage from '../auth/WaitlistPage.jsx';

export default function RootRouter() {
  const { user, loading: authLoading } = useAuth();
  const [decision, setDecision] = useState(null); // 'business' | 'client' | null
  // Launch state for logged-out visitors: null while loading, then the
  // /early-access/status payload. Only matters when logged out.
  const [launch, setLaunch] = useState(null);

  useEffect(() => {
    if (!user) { setDecision(null); return; }
    let live = true;
    api.get('/me')
      .then((r) => {
        if (!live) return;
        // Owner who hasn't finished onboarding → wizard.
        if (r.isOwner && !r.onboardedAt) { setDecision('onboarding'); return; }
        if (r.isOwner) setDecision('business');
        else if (r.isClient) setDecision('client');
        else setDecision('business'); // workspace got auto-created on signup
      })
      .catch(() => live && setDecision('business'));
    return () => { live = false; };
  }, [user]);

  // Logged-out visitors: check the controlled-launch switch so "/" shows
  // the waitlist page pre-launch instead of the marketing home.
  useEffect(() => {
    if (user) return;
    let live = true;
    api.get('/early-access/status')
      .then((r) => { if (live) setLaunch(r); })
      .catch(() => { if (live) setLaunch({ launchMode: 'open', bypassed: true }); });
    return () => { live = false; };
  }, [user]);

  // Logged-out → waitlist (pre-launch) or marketing (launched). Wait for
  // the launch check so we don't flash the marketing home first.
  if (!authLoading && !user) {
    if (launch === null) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--muted)', fontSize: 13, background: 'var(--page)',
        }}>Loading…</div>
      );
    }
    if (launch.launchMode === 'waitlist' && !launch.bypassed) {
      return <WaitlistPage hasBetaPassword={!!launch.hasBetaPassword} />;
    }
    return <MarketingHome/>;
  }

  // Initial /api/me still pending → keep the marketing chrome until we know,
  // because flashing a sign-in screen first would feel like a redirect bug.
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
  if (decision === 'onboarding') return <Navigate to="/onboarding" replace/>;
  if (decision === 'client')     return <Navigate to="/me" replace/>;
  return <Navigate to="/dashboard" replace/>;
}
