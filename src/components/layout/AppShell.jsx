// AppShell — viewport-aware layout.
//   Desktop (≥ 1024px): full sidebar (248px) + topbar + main
//   Tablet  (721-1024): icon-only sidebar (64px) + topbar + main
//   Mobile  (≤ 720px):  hamburger button + slide-in drawer + bottom nav + main
//
// Wraps everything in UserContextProvider so the floating ViewToggle and
// the Paywall (which gates the business app when the workspace's
// subscription isn't active) can read /api/me from a single round-trip.
import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';
import VerifyEmailBanner from '../VerifyEmailBanner.jsx';
import MobileBottomNav from './MobileBottomNav.jsx';
import MobileDrawer from './MobileDrawer.jsx';
import ViewToggle from '../ViewToggle.jsx';
import Paywall from '../../features/billing/Paywall.jsx';
import SubscriptionBanner from '../../features/billing/SubscriptionBanner.jsx';
import { NAV, TITLES } from '../../lib/nav.js';
import { useTweaks } from '../../lib/tweaks.js';
import { useViewport } from '../../lib/viewport.js';
import { UserContextProvider, useUserContext } from '../../lib/userContext.jsx';

export default function AppShell() {
  return (
    <UserContextProvider>
      <AppShellInner/>
    </UserContextProvider>
  );
}

function AppShellInner() {
  const [tweaks] = useTweaks();
  const location = useLocation();
  const viewport = useViewport();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { ctx, refresh } = useUserContext();
  const current = NAV.find(n => n.to === location.pathname) || NAV[0];
  const t = TITLES[current.id] || TITLES.dashboard;

  // Paywall only applies to owners. Client-only users land here briefly
  // when the role router is still resolving — never gate them.
  const needsPaywall = ctx?.isOwner && !ctx?.subscription?.isActive;

  // Mirror the direction class onto <body> so React portals (dropdowns, modals)
  // rendered into document.body inherit the same CSS variables we use everywhere.
  useEffect(() => {
    document.body.classList.remove('dir-calm', 'dir-bold');
    document.body.classList.add(`dir-${tweaks.direction}`);
    return () => document.body.classList.remove(`dir-${tweaks.direction}`);
  }, [tweaks.direction]);

  // Reserve space for the fixed bottom nav on mobile so page content can
  // scroll past it. Toggled via body class so global.css handles the rest.
  useEffect(() => {
    if (viewport.isMobile) document.body.classList.add('has-mobile-nav');
    else document.body.classList.remove('has-mobile-nav');
    return () => document.body.classList.remove('has-mobile-nav');
  }, [viewport.isMobile]);

  // Close the drawer on route change so nav-tap-to-page just works.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  return (
    <div className={`app-root dir-${tweaks.direction}`}>
      <div style={{ display: 'flex', alignItems: 'stretch', minHeight: '100vh' }}>
        {viewport.isDesktop && <Sidebar direction={tweaks.direction} variant="full" />}
        {viewport.isTablet  && <Sidebar direction={tweaks.direction} variant="compact" />}

        <main style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column',
          minHeight: '100vh',
        }}>
          <SubscriptionBanner />
          <VerifyEmailBanner />
          <Topbar
            title={t.title}
            subtitle={t.subtitle}
            isMobile={viewport.isMobile}
            isTablet={viewport.isTablet}
            onMenuClick={() => setDrawerOpen(true)}
          />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Outlet />
          </div>
        </main>
      </div>

      {viewport.isMobile && <MobileBottomNav />}
      {viewport.isMobile && drawerOpen && (
        <MobileDrawer direction={tweaks.direction} onClose={() => setDrawerOpen(false)} />
      )}

      <ViewToggle ctx={ctx}/>

      {needsPaywall && <Paywall ctx={ctx} onRefresh={refresh}/>}
    </div>
  );
}
