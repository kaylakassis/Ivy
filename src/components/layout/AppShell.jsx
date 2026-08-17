// AppShell - viewport-aware layout.
//   Desktop (≥ 1024px): full sidebar (248px) + topbar + main
//   Tablet  (721-1024): icon-only sidebar (64px) + topbar + main
//   Mobile  (≤ 720px):  hamburger button + slide-in drawer + bottom nav + main
//
// Wraps everything in UserContextProvider so the floating ViewToggle and
// the Paywall (which gates the business app when the workspace's
// subscription isn't active) can read /api/me from a single round-trip.
import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { ErrorBoundary } from '../../lib/monitoring.js';
import { tryStaleChunkRecovery } from '../../lib/staleChunk.js';
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
import { initNativePushOnLaunch } from '../../lib/nativePush.js';
import { UserContextProvider, useUserContext } from '../../lib/userContext.jsx';
import { useAuth } from '../../lib/auth.jsx';

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
  // /account is reached from the sidebar profile menu and isn't in
  // NAV proper. Resolve it explicitly so the Topbar shows the right
  // title + the right tutorial (rather than falling back to NAV[0]
  // and blasting the Dashboard tutorial on every Account visit).
  const ACCOUNT = { id: 'account', to: '/account' };
  const current = location.pathname === '/account'
    ? ACCOUNT
    : (NAV.find(n => n.to === location.pathname) || NAV[0]);
  const t = TITLES[current.id] || TITLES.dashboard;

  // Paywall only applies to owners. Client-only users land here briefly
  // when the role router is still resolving - never gate them.
  //
  // Preview hook: a super-admin can force the wall to render via
  // ?previewPaywall=1 to see the live component on any deploy without
  // expiring a real subscription. Gated to isSuperAdmin so it's not a
  // public bypass of anything (the wall blocks, it never grants access),
  // and it only forces the wall ON - it can't turn a real wall off.
  const { user: authUser } = useAuth();
  const previewPaywall = !!authUser?.isSuperAdmin
    && new URLSearchParams(location.search).get('previewPaywall') === '1';
  const needsPaywall = (ctx?.isOwner && !ctx?.subscription?.isActive) || previewPaywall;

  // Auto-launch the in-app walkthrough on first render after signup +
  // onboarding complete. AccountPage's "Replay" button writes
  // ?walkthrough=1 into the URL to override the dismissed state without
  // a full DB refetch round-trip.
  const walkthroughRequested = location.search.includes('walkthrough=1');
  // Tight gate: don't auto-launch the walkthrough until we KNOW the
  // workspace is active. Without the explicit isActive check, a brief
  // window while ctx is still loading (or a stale ?walkthrough=1 in the
  // URL on a still-incomplete workspace) renders the walkthrough modal
  // on TOP of the paywall, blocking the user from starting their trial.
  // The walkthrough naturally fires the moment they activate.
  const subActive = ctx?.subscription?.isActive === true;
  // Opt-in only: the 12-step spotlight tour no longer auto-launches after
  // onboarding (it stacked on top of the new Ivy-led first run and overwhelmed
  // new users). It fires only on an explicit request — AccountPage's "Replay
  // tour" button (?walkthrough=1) or a programmatic override.
  const showWalkthrough = !needsPaywall
    && subActive
    && walkthroughOverride !== false
    && (walkthroughOverride === true || walkthroughRequested);

  // Native app: silently refresh the APNs device token on launch when
  // the user already granted notifications (Apple rotates tokens; the
  // server upserts). No-op on web, never prompts.
  useEffect(() => { initNativePushOnLaunch(); }, []);

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

  // Hard paywall body class: tells global.css to (a) scroll-lock the page
  // behind the wall and (b) hide the floating .view-toggle pill (the
  // previous escape hatch). The Paywall renders the isClient carve-out
  // itself when applicable, so removing the global toggle is safe.
  useEffect(() => {
    if (needsPaywall) document.body.classList.add('app-walled');
    else document.body.classList.remove('app-walled');
    return () => document.body.classList.remove('app-walled');
  }, [needsPaywall]);

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
            paywalled={needsPaywall}
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
            {/* Per-route error boundary keyed by URL so navigating away
                from a crashed route auto-resets the boundary (the user
                isn't stuck on the snag screen forever). Sidebar, topbar
                and viewport switcher remain interactive so they can
                pick a different tab without losing their session. */}
            <ErrorBoundary
              key={location.pathname}
              fallback={({ resetError, error }) => (
                <RouteCrashInline error={error} resetError={resetError}/>
              )}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {viewport.isMobile && <MobileBottomNav />}
      {viewport.isMobile && drawerOpen && (
        <MobileDrawer direction={tweaks.direction} onClose={() => setDrawerOpen(false)} />
      )}

      {needsPaywall && <Paywall ctx={ctx} onRefresh={refresh}/>}

      {/* Super-admin preview escape: the wall is unskippable by design, so
          when it's been FORCED on for preview we surface a clear way back
          out (navigating to the bare path drops ?previewPaywall=1). Sits
          above the wall's z-index (200). Never rendered for a real wall. */}
      {previewPaywall && (
        <a href={location.pathname} style={{
          position: 'fixed', top: 14, right: 14, zIndex: 210,
          padding: '7px 12px', borderRadius: 999,
          background: 'var(--fg)', color: 'var(--page)',
          fontSize: 12.5, fontWeight: 600, textDecoration: 'none',
          boxShadow: 'var(--shadow)',
        }}>Exit paywall preview →</a>
      )}

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
      {/* Ivy bubble - only render once the user is past the paywall and
          (when applicable) the walkthrough overlay isn't covering the
          screen. Otherwise the FAB peeks through the modal scrim. */}
      {!needsPaywall && !showWalkthrough && <IvyDock/>}
      {/* Per-tab tutorial overlay. Reads activeTabId from TutorialProvider;
          renders nothing until a tab is opened (auto-trigger from Topbar
          on first visit, or manual via the (i) button). Gated on the paywall
          (like IvyDock above) so it can never cover the "Start your trial"
          wall — the tutorial appears once the owner is past it. */}
      {!needsPaywall && <TutorialOverlay/>}
    </div>
  );
}

// Inline fallback rendered inside the AppShell when a single business
// route (Dashboard, Clients, Calendar, Finance, etc.) crashes at render
// time. Sidebar + Topbar + ViewToggle stay live around it so the user
// can navigate to a different tab. Includes the actual error message so
// support can pinpoint the issue from a screenshot.
function RouteCrashInline({ error, resetError }) {
  // Auto-reload on stale-chunk error (deploy mid-session). Same as
  // FatalFallback in main.jsx and RouteCrash in App.jsx - every error
  // boundary path checks this so the user never lands on a snag
  // screen because of a content-hashed asset rotation.
  if (tryStaleChunkRecovery(error)) return null;
  const msg = (error && (error.message || String(error))) || 'unknown';
  return (
    <div style={{ padding: 32 }}>
      <div className="card" style={{ padding: 22, maxWidth: 580 }}>
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500,
          letterSpacing: '-0.02em', marginBottom: 8,
        }}>This tab couldn't load.</div>
        <div style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.55, marginBottom: 12 }}>
          The rest of your workspace is still working - pick another tab
          from the sidebar, or try this one again.
        </div>
        <div style={{
          fontSize: 11.5, color: 'var(--muted-2)', background: 'var(--surface-2)',
          border: '1px solid var(--border)', borderRadius: 8,
          padding: '8px 10px', marginBottom: 14, fontFamily: 'ui-monospace, monospace',
          wordBreak: 'break-word',
        }}>
          {msg.slice(0, 280)}
        </div>
        <button onClick={resetError} className="btn btn-primary"
          style={{ padding: '8px 16px' }}>Try again</button>
      </div>
    </div>
  );
}
