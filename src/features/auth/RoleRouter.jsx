// On the business routes, decide whether the user belongs in the business
// app or the client portal. Owner-only → business view. Client-only → /me.
// Both → business view by default (they can switch via the menu).
//
// Uses the shared fetchMe() so this is the same round trip RootRouter and
// UserContextProvider already made, not a new one. When the device
// remembers the last confirmed landing, the shell renders immediately and
// the fresh /me only has to confirm it - so the dashboard's own requests
// start in parallel with the role check instead of queueing behind it.
import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth.jsx';
import { isNative } from '../../lib/platform.js';
import { fetchMe, decideLanding, rememberLanding, rememberedLanding } from '../../lib/landing.js';
import LaunchFrame from '../../components/LaunchFrame.jsx';

export default function RoleRouter({ children }) {
  const { user, loading: authLoading } = useAuth();
  const [decision, setDecision] = useState(null); // 'onboarding' | 'business' | 'client' | null
  const [remembered] = useState(rememberedLanding);

  useEffect(() => {
    if (!user) return;
    let live = true;
    fetchMe()
      .then((r) => {
        const d = decideLanding(r, user);
        rememberLanding(d);
        if (live) setDecision(d);
      })
      .catch(() => live && setDecision('business')); // the empty business shell is harmless
    return () => { live = false; };
  }, [user]);

  if (authLoading || !user) return children; // RequireAuth handles the rest
  const effective = decision || remembered;
  if (!effective) {
    if (isNative()) return <LaunchFrame/>;
    return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  }
  if (effective === 'onboarding') return <Navigate to={{ pathname: '/onboarding', search: window.location.search }} replace/>;
  if (effective === 'client')     return <Navigate to={{ pathname: '/me', search: window.location.search }} replace/>;
  if (effective === 'helper')     return <Navigate to={{ pathname: '/helper', search: window.location.search }} replace/>;
  return children;
}
