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
        if (r.isOwner && !r.onboardedAt) { setDecision('onboarding'); return; }
        if (r.isOwner) setDecision('business');
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
