// On the root '/' route, decide whether the user lands in the business app
// or the client portal. Owner-only → business view. Client-only → /me.
// Both → business view by default (they can switch via the menu).
//
// Wraps the auth-gated children so we don't have to re-fetch /api/me on
// every page load — the AppShell stays the cache.
import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';

export default function RoleRouter({ children }) {
  const { user, loading: authLoading } = useAuth();
  const [decision, setDecision] = useState(null); // 'business' | 'client' | null
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user) return;
    let live = true;
    api.get('/me')
      .then((r) => {
        if (!live) return;
        // Fresh owner who hasn't completed onboarding → wizard.
        // Exception: the user explicitly clicked "Save & exit" (which
        // sets thryve_skip_onboarding_until to a future timestamp).
        // That bypass keeps the dashboard reachable even when
        // /api/onboarding/complete has failed server-side — we don't
        // want owners stuck on the welcome screen because of a server
        // hiccup. The flag self-expires after 24h.
        let skipUntil = 0;
        try { skipUntil = Number(localStorage.getItem('thryve_skip_onboarding_until')) || 0; }
        catch { /* private mode */ }
        const skipping = skipUntil > Date.now();
        if (r.isOwner && !r.onboardedAt && !skipping) { setDecision('onboarding'); return; }
        // Super-admins always land in the business shell so the /admin tab
        // is reachable, even if they're only a client elsewhere.
        const isSuperAdmin = !!(user?.isSuperAdmin || r.isSuperAdmin);
        if (r.isOwner || isSuperAdmin) setDecision('business');
        else if (r.isClient) setDecision('client');
        else setDecision('business'); // fall back; the empty business shell is harmless
      })
      .catch((e) => {
        if (!live) return;
        setError(e);
        setDecision('business');
      });
    return () => { live = false; };
  }, [user]);

  if (authLoading || !user) return children; // RequireAuth handles the rest
  if (!decision) {
    return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  }
  if (decision === 'onboarding') return <Navigate to="/onboarding" replace/>;
  if (decision === 'client')     return <Navigate to="/me" replace/>;
  return children;
}
