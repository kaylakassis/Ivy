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
import Paywall from '../../features/billing/Paywall.jsx';
import SubscriptionBanner from '../../features/billing/SubscriptionBanner.jsx';
import Walkthrough from '../../features/onboarding/Walkthrough.jsx';
import ImpersonationBanner from '../ImpersonationBanner.jsx';
import CommandPalette from '../CommandPalette.jsx';
import TermsAcceptModal from '../TermsAcceptModal.jsx';
import IvyDock from '../../features/ivy/IvyDock.jsx';
import { IvyProvider } from '../../features/ivy/state.jsx';
import TutorialOverlay from '../TutorialOverlay.jsx';
import { TutorialProvider } from '../../lib/tutorialState.jsx';
import { NAV, TITLES } from '../../lib/nav.js';
import { useTweaks } from '../../lib/tweaks.js';
import { useViewport } from '../../lib/viewport.js';
import { UserContextProvider, useUserContext } from '../../lib/userContext.jsx';

export default function AppShell() {
  return (
    <UserContextProvider>
      <IvyProvider>
        <TutorialProvider>
          <AppShellInner/>
        </TutorialProvider>
      </IvyProvider>
    </UserContextProvider>
  );
}

function AppShellInner() {
  const [tweaks] = useTweaks();
  const location = useLocation();
  const viewport = useViewport();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [walkthroughOverride, setWalkthroughOverride] = useState(null);
  const { ctx, refresh } = useUserContext();
  const current = NAV.find(n => n.to === location.pathname) || NAV[0];
  const t = TITLES[current.id] || TITLES.dashboard;

  // Paywall only applies to owners. Client-only users land here briefly
  // when the role router is still resolving — never gate them.
  const needsPaywall = ctx?.isOwner && !ctx?.subscription?.isActive;

  // Auto-launch the in-app walkthrough on first render after signup +
  // onboarding complete. AccountPage's "Replay" button writes
  // ?walkthrough=1 into the URL to override the dismissed state without
  // a full DB refetch round-trip.
  const walkthroughRequested = location.search.includes('walkthrough=1');
  const showWalkthrough = !needsPaywall
    && walkthroughOverride !== false
    && (walkthroughOverride === true
        || walkthroughRequested
        || (ctx?.isOwner && ctx?.onboardedAt && !ctx?.walkthroughCompletedAt));

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
      <ImpersonationBanner/>
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
            tabId={current.id}
            isMobile={viewport.isMobile}
            isTablet={viewport.isTablet}
            onMenuClick={() => setDrawerOpen(true)}
          />
          {/* Bottom padding reserves space for the floating ViewToggle
              pill (sits at bottom: 18, ~50px tall) so it can never
              overlap the last row of content. .page-pad already adds
              96px on pages that opt in; this catches pages that don't
              (Dashboard, etc.). Mobile gets its own reservation via
              body.has-mobile-nav rules. */}
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
            paddingBottom: viewport.isMobile ? 0 : 80,
          }}>
            <Outlet />
          </div>
        </main>
      </div>

      {viewport.isMobile && <MobileBottomNav />}
      {viewport.isMobile && drawerOpen && (
        <MobileDrawer direction={tweaks.direction} onClose={() => setDrawerOpen(false)} />
      )}

      {needsPaywall && <Paywall ctx={ctx} onRefresh={refresh}/>}

      {showWalkthrough && (
        <Walkthrough onClose={() => {
          setWalkthroughOverride(false);
          // Strip ?walkthrough=1 from the URL so a refresh doesn't
          // re-open the tour after the user dismissed it.
          if (walkthroughRequested) {
            const u = new URL(window.location.href);
            u.searchParams.delete('walkthrough');
            window.history.replaceState({}, '', u.pathname + (u.search ? u.search : ''));
          }
          refresh();
        }}/>
      )}

      <CommandPalette/>
      <TermsAcceptModal/>
      {/* Ivy bubble — only render once the user is past the paywall and
          (when applicable) the walkthrough overlay isn't covering the
          screen. Otherwise the FAB peeks through the modal scrim. */}
      {!needsPaywall && !showWalkthrough && <IvyDock/>}
      {/* Per-tab tutorial overlay. Reads activeTabId from TutorialProvider;
          renders nothing until a tab is opened (auto-trigger from Topbar
          on first visit, or manual via the (i) button). */}
      <TutorialOverlay/>
    </div>
  );
}
