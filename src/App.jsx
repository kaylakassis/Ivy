// Top-level route table. Route components are lazy-loaded so a visitor
// reading the marketing site does not download the business app, the
// client portal or the sign-in pages before the page can start. Eager:
//   RootRouter, RequireAuth, RoleRouter, the launch veil and app lock
//   (native), and the small always-mounted helpers below.
// Everything else loads on demand inside <Suspense>; the fallback is a
// minimal centered spinner so navigation never feels stuck. Every lazy
// route uses lazyRoute() so it can be fetched ahead of its first render:
// main.jsx loads the current page's chunk before mounting where the page
// used to be eager (pre-rendered pages, sign-in, sign-up) and warmApp()
// starts the app shell for signed-in visitors and the phone app while the
// session check runs, so nobody waits on a chunk they did not wait on
// before.
import React, { Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { isNative } from './lib/platform.js';
import Loader from './components/motion/Loader.jsx';
import ViewToggle from './components/ViewToggle.jsx';
import PWAPrompts from './components/PWAPrompts.jsx';
import NativeAppLock from './components/NativeAppLock.jsx';
import LaunchVeil from './lib/launchVeil.jsx';
import NativeUrlOpens from './components/NativeUrlOpens.jsx';
import RequireAuth from './features/auth/RequireAuth.jsx';
import RoleRouter from './features/auth/RoleRouter.jsx';
import RootRouter, { MarketingHome } from './features/marketing/RootRouter.jsx';
import { ClientPortalProvider } from './features/client/clientContext.jsx';
import { ErrorBoundary } from './lib/monitoring.js';
import { tryStaleChunkRecovery } from './lib/staleChunk.js';
import { isPlatformHost } from './lib/publicUrl.js';
import { lazyRoute } from './lib/lazyRoute.js';
import { rememberedLanding } from './lib/landing.js';
import GetAppBanner from './components/GetAppBanner.jsx';

const normalPath = (pathname) => String(pathname || '/').replace(/\/+$/, '') || '/';
const under = (p, prefix) => p === prefix || p.startsWith(prefix + '/');
// The chunk of the page a shell is about to show, from a path → component
// map (exact match, else the longest matching prefix).
function pageFor(map, pathname) {
  const p = normalPath(pathname);
  if (map[p]) return map[p];
  const key = Object.keys(map).filter((k) => under(p, k)).sort((a, b) => b.length - a.length)[0];
  return key ? map[key] : null;
}
const warm = (...components) => components.forEach((C) => { if (C) C.preload().catch(() => {}); });
// Set by lib/auth.jsx while this device has a signed-in session.
function hasSessionHint() {
  try { return localStorage.getItem('ivy_signed_in') === '1'; } catch { return false; /* private mode */ }
}

// ── Lazy: business app pages ──
const Dashboard   = lazyRoute(() => import('./features/dashboard/Dashboard.jsx'));
const Clients     = lazyRoute(() => import('./features/clients/Clients.jsx'));
const ProgramsPage = lazyRoute(() => import('./features/programs/ProgramsPage.jsx'));
const PublicProgram = lazyRoute(() => import('./features/programs/PublicProgram.jsx'));
const ClientPrograms = lazyRoute(() => import('./features/client/ClientPrograms.jsx'));
const ClientProgram = lazyRoute(() => import('./features/client/ClientPrograms.jsx').then((m) => ({ default: m.ClientProgram })));
const ClientLesson = lazyRoute(() => import('./features/client/ClientPrograms.jsx').then((m) => ({ default: m.ClientLesson })));
const Calendar    = lazyRoute(() => import('./features/calendar/Calendar.jsx'));
const Finance     = lazyRoute(() => import('./features/finance/Finance.jsx'));
const Marketing   = lazyRoute(() => import('./features/grow/Marketing.jsx'));
const Reviews     = lazyRoute(() => import('./features/reviews/Reviews.jsx'));
const Messages    = lazyRoute(() => import('./features/messages/Messages.jsx'));
const Documents   = lazyRoute(() => import('./features/documents/Documents.jsx'));
const Website     = lazyRoute(() => import('./features/website/Website.jsx'));
const IvyPro      = lazyRoute(() => import('./features/ivy/IvyPro.jsx'));
const AccountPage = lazyRoute(() => import('./features/account/AccountPage.jsx'));
const AdminPage   = lazyRoute(() => import('./features/admin/AdminPage.jsx'));
const MorePage    = lazyRoute(() => import('./features/more/MorePage.jsx'));
const ShopsPage   = lazyRoute(() => import('./features/shops/ShopsPage.jsx'));

// ── Lazy: client portal ──
const ClientHome      = lazyRoute(() => import('./features/client/ClientHome.jsx'));
const ClientMessages  = lazyRoute(() => import('./features/client/ClientMessages.jsx'));
const ClientBookings  = lazyRoute(() => import('./features/client/ClientBookings.jsx'));
const ClientInvoices  = lazyRoute(() => import('./features/client/ClientInvoices.jsx'));
const ClientDocuments = lazyRoute(() => import('./features/client/ClientDocuments.jsx'));
const ClientDiscover  = lazyRoute(() => import('./features/client/ClientDiscover.jsx'));
const ClientNotifications = lazyRoute(() => import('./features/client/ClientNotifications.jsx'));
const ClientProfile   = lazyRoute(() => import('./features/client/ClientProfile.jsx'));
const AcceptGroupInvite = lazyRoute(() => import('./features/client/AcceptGroupInvite.jsx'));

// ── Lazy: helper shell (an owner's assistant with their own small view) ──
const HelperSchedule     = lazyRoute(() => import('./features/helper/HelperSchedule.jsx'));
const HelperAccount      = lazyRoute(() => import('./features/helper/HelperAccount.jsx'));
const HelperClients      = lazyRoute(() => import('./features/helper/HelperClients.jsx'));
const HelperMessages     = lazyRoute(() => import('./features/helper/HelperMessages.jsx'));
const AcceptHelperInvite = lazyRoute(() => import('./features/helper/AcceptHelperInvite.jsx'));
const NotFoundPage    = lazyRoute(() => import('./features/marketing/NotFoundPage.jsx'));

// ── Lazy: secondary auth flows + onboarding ──
const ForgotPasswordPage = lazyRoute(() => import('./features/auth/ForgotPasswordPage.jsx'));
const ResetPasswordPage  = lazyRoute(() => import('./features/auth/ResetPasswordPage.jsx'));
const VerifyEmailPage    = lazyRoute(() => import('./features/auth/VerifyEmailPage.jsx'));
const AccountRecoverPage = lazyRoute(() => import('./features/auth/AccountRecoverPage.jsx'));
const OnboardingPage     = lazyRoute(() => import('./features/onboarding/OnboardingPage.jsx'));

// ── Lazy: the signed-in shells ──
// The page each shell shows first, by path. A shell's importer starts that
// page's chunk alongside its own, so opening /calendar fetches the shell
// and the calendar at the same time, never one after the other.
const OWNER_PAGES = {
  '/dashboard': Dashboard, '/clients': Clients, '/programs': ProgramsPage, '/calendar': Calendar,
  '/finance': Finance, '/marketing': Marketing, '/reviews': Reviews, '/messages': Messages,
  '/documents': Documents, '/website': Website, '/ivy': IvyPro, '/account': AccountPage,
  '/more': MorePage, '/admin': AdminPage, '/shops': ShopsPage,
};
const CLIENT_PAGES = {
  '/me': ClientHome, '/me/messages': ClientMessages, '/me/bookings': ClientBookings,
  '/me/invoices': ClientInvoices, '/me/documents': ClientDocuments, '/me/discover': ClientDiscover,
  '/me/notifications': ClientNotifications, '/me/profile': ClientProfile, '/me/programs': ClientPrograms,
};
const HELPER_PAGES = {
  '/helper': HelperSchedule, '/helper/clients': HelperClients, '/helper/messages': HelperMessages,
  '/helper/account': HelperAccount,
};
const withPage = (map, importer) => () => {
  warm(pageFor(map, window.location.pathname));
  return importer();
};
const AppShell    = lazyRoute(withPage(OWNER_PAGES, () => import('./components/layout/AppShell.jsx')));
const ClientShell = lazyRoute(withPage(CLIENT_PAGES, () => import('./features/client/ClientShell.jsx')));
const HelperShell = lazyRoute(withPage(HELPER_PAGES, () => import('./features/helper/HelperShell.jsx')));

// ── Lazy: sign in / sign up ──
// Someone on the sign-in page is about to open the app: once the page is
// up, fetch the business shell in the background.
const AuthPage = lazyRoute(() => import('./features/auth/AuthPage.jsx').then((m) => {
  setTimeout(() => warm(AppShell), 1500);
  return m;
}));
const EarlyAccessGate = lazyRoute(() => import('./features/auth/EarlyAccessGate.jsx'));

// ── Lazy: public surfaces (often a fresh visit's first hit) ──
const PublicBooking = lazyRoute(() => import('./features/calendar/PublicBooking.jsx'));
const PublicShop    = lazyRoute(() => import('./features/shops/PublicShop.jsx'));
const AcceptShopInvite = lazyRoute(() => import('./features/shops/AcceptShopInvite.jsx'));
const PublicPolicyPage = lazyRoute(() => import('./features/calendar/PublicPolicyPage.jsx'));
const PublicSite    = lazyRoute(() => import('./features/website/PublicSite.jsx'));
const EmbedContact  = lazyRoute(() => import('./features/embed/EmbedContact.jsx'));
const SignPage      = lazyRoute(() => import('./features/documents/SignPage.jsx'));
const ConnectedPage = lazyRoute(() => import('./features/finance/ConnectedPage.jsx'));
const PublicInvoice = lazyRoute(() => import('./features/finance/PublicInvoice.jsx'));
const PublicQuote   = lazyRoute(() => import('./features/finance/PublicQuote.jsx'));
const ReviewPage    = lazyRoute(() => import('./features/reviews/ReviewPage.jsx'));
const WelcomePage   = lazyRoute(() => import('./features/auth/WelcomePage.jsx'));
const WaitlistPage    = lazyRoute(() => import('./features/auth/WaitlistPage.jsx'));

// ── Lazy: public marketing + legal pages ──
// These are pre-rendered to static HTML at build time (scripts/prerender.mjs),
// so they use lazyRoute(): main.jsx preloads the current page's chunk before
// mounting and React's first render commits the page itself, not the spinner,
// over the static copy the visitor is already looking at.
const PrivacyPage   = lazyRoute(() => import('./features/legal/PrivacyPage.jsx'));
const TermsPage     = lazyRoute(() => import('./features/legal/TermsPage.jsx'));
const DoNotSellPage = lazyRoute(() => import('./features/legal/DoNotSellPage.jsx'));
const SiteAbout     = lazyRoute(() => import('./features/marketing/site/SiteAbout.jsx'));
const SiteSupport   = lazyRoute(() => import('./features/marketing/site/SiteSupport.jsx'));
const VerticalPage  = lazyRoute(() => import('./features/marketing/VerticalPage.jsx'));
const SitePricing     = lazyRoute(() => import('./features/marketing/site/SitePricing.jsx'));
const SiteTour        = lazyRoute(() => import('./features/marketing/site/SiteTour.jsx'));
const SiteFeatures    = lazyRoute(() => import('./features/marketing/site/SiteFeatures.jsx'));
const SecurityPage    = lazyRoute(() => import('./features/marketing/SecurityPage.jsx'));
const MobilePage      = lazyRoute(() => import('./features/marketing/MobilePage.jsx'));
const IntegrationsPage = lazyRoute(() => import('./features/marketing/IntegrationsPage.jsx'));

// Pre-rendered path → the chunk its route needs ("/" is handled below).
const PRERENDERED_ROUTES = {
  '/privacy': PrivacyPage, '/terms': TermsPage, '/do-not-sell': DoNotSellPage,
  '/about': SiteAbout, '/support': SiteSupport, '/pricing': SitePricing,
  '/tour': SiteTour, '/features': SiteFeatures,
  '/security': SecurityPage, '/mobile': MobilePage, '/integrations': IntegrationsPage,
};
// The chunks a page needs before React's first commit, so the first thing
// React paints is the page itself and never the route spinner: the
// pre-rendered pages (the visitor is already reading them) and the sign-in
// and sign-up entry pages (they used to be in the main bundle).
// "/" needs the marketing home unless a signed-in visitor is about to be
// sent on to the app (the server only pre-renders "/" for visitors without
// a session cookie).
export function preloadRoute(pathname) {
  const p = normalPath(pathname);
  if (p === '/signin' || p === '/signup') return Promise.all([AuthPage.preload(), EarlyAccessGate.preload()]);
  if (p === '/') {
    const prerendered = document.documentElement.hasAttribute('data-prerendered');
    return prerendered || !hasSessionHint() ? MarketingHome.preload() : Promise.resolve();
  }
  const C = PRERENDERED_ROUTES[p]
    || (p.startsWith('/for/') ? VerticalPage : null);
  return C ? C.preload() : Promise.resolve();
}

// Signed-in visitors and the phone app are headed into the app, not the
// marketing site: start fetching the shell (and, through the shell's
// importer, the page) they will land on while the session check runs.
// Nothing waits on this; it only makes sure the chunks are there by the
// time the session is confirmed.
export function warmApp(pathname) {
  const signedIn = hasSessionHint();
  const native = isNative();
  if (!signedIn) {
    // Phone app, signed out: the welcome screen, then sign in or sign up.
    if (native) warm(WelcomePage, AuthPage, EarlyAccessGate);
    return;
  }
  const p = normalPath(pathname);
  if (under(p, '/me')) warm(ClientShell);
  else if (under(p, '/helper')) warm(HelperShell);
  else if (under(p, '/onboarding')) warm(OnboardingPage);
  else if (p === '/') {
    const landing = rememberedLanding();
    if (landing === 'client') warm(ClientShell, ClientHome);
    else if (landing === 'helper') warm(HelperShell, HelperSchedule);
    else warm(AppShell, Dashboard);
  } else if (native || pageFor(OWNER_PAGES, p)) warm(AppShell);
}

// Centered, low-key spinner. Avoids blank-flash but doesn't fight the
// destination page's own loader for visual real estate. Lives inside
// the route so it only renders during chunk fetches.
//
// Inside the business app it shows the branded Loader with a playful line
// about Ivy getting ready (after a 300ms grace so quick loads never flash).
// Client-facing pages (portal, booking, invoices...) get the client set of
// lines; the marketing site and auth pages keep the quiet spinner.
const OWNER_PREFIXES = ['/dashboard', '/clients', '/calendar', '/finance', '/messages', '/ivy',
  '/programs', '/marketing', '/reviews', '/website', '/documents', '/admin', '/account', '/more', '/onboarding', '/shops'];
const CLIENT_PREFIXES = ['/me', '/helper', '/book/', '/invoice/', '/quote/', '/sign/', '/review/', '/site/', '/embed/', '/shop/'];
function RouteFallback({ client = false }) {
  const { pathname } = useLocation();
  const hit = (list) => list.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : p + '/'));
  const set = client || hit(CLIENT_PREFIXES) ? 'client' : hit(OWNER_PREFIXES) ? 'owner' : null;
  if (set) {
    return (
      <div className="page-frame page-enter" style={{ minHeight: '60vh', justifyContent: 'center' }}>
        <Loader set={set}/>
      </div>
    );
  }
  return (
    <div className="page-enter" style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--muted)', fontSize: 13,
    }}>
      <div style={{
        width: 12, height: 12, borderRadius: 99,
        border: '2px solid var(--border)',
        borderTopColor: 'var(--accent)',
        animation: 'ivy-spin 0.7s linear infinite',
      }}/>
    </div>
  );
}

// Page-scoped failure card. Surface enough info that a user can
// recover OR get unstuck:
//   • Show the actual error message (it's their session; safe to show).
//   • "Try again" - resets the boundary.
//   • "Go home"  - hard navigate to /, clears the route, clears any
//     localStorage onboarding gate so a fresh load isn't trapped.
//   • "Sign out" - clears auth cookie and bounces.
//   • Email link with the error pre-filled.
function RouteCrash({ resetError, error }) {
  // First: if this is a stale-chunk error from a fresh Vercel deploy,
  // hard-reload to fetch the new index.html. The user never sees this
  // screen in that case.
  if (tryStaleChunkRecovery(error)) return null;
  const msg = (error && (error.message || String(error))) || 'unknown';
  const goHome = () => {
    try {
      // If the user has a stale onboarding-skip flag from a prior session
      // it could be sending them through a broken redirect chain. Clear
      // it on hard recovery.
      localStorage.removeItem('ivy_skip_onboarding_until');
    } catch { /* private mode */ }
    window.location.href = '/';
  };
  const signOut = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    try { localStorage.clear(); } catch {}
    window.location.href = '/';
  };
  const mail = `mailto:hello@joinivy.ai?subject=${encodeURIComponent('Error on Ivy')}&body=${encodeURIComponent(`I hit an error: ${msg}\n\nURL: ${typeof window !== 'undefined' ? window.location.href : ''}\n\n`)}`;
  // The colour tokens live on .dir-calm / .dir-bold, which the app shell
  // puts on <body> and removes when it unmounts - and a crash unmounts it.
  // Without the class this card rendered black text on a black page and
  // was unreadable. Carry the owner's direction on the wrapper itself.
  let direction = 'bold';
  try { direction = JSON.parse(localStorage.getItem('Ivy:tweaks') || '{}').direction || 'bold'; } catch { /* default */ }
  return (
    <div className={`dir-${direction}`} style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, background: 'var(--page)', color: 'var(--fg)', fontFamily: 'var(--font-sans)',
    }}>
      <div className="card" style={{
        maxWidth: 480, padding: 28, textAlign: 'center',
      }}>
        <div style={{
          fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500,
          letterSpacing: '-0.02em', marginBottom: 10,
        }}>Something went wrong.</div>
        <div style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.55, marginBottom: 14 }}>
          We've logged it on our side. While we look into it, you can try a
          few things below to get back to work.
        </div>
        <div style={{
          fontSize: 11.5, color: 'var(--muted-2)', background: 'var(--surface-2)',
          border: '1px solid var(--border)', borderRadius: 8,
          padding: '8px 10px', marginBottom: 18, fontFamily: 'ui-monospace, monospace',
          wordBreak: 'break-word', textAlign: 'left',
        }}>
          {msg.slice(0, 280)}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button onClick={resetError} className="btn btn-primary"
            style={{ padding: '8px 16px' }}>Try again</button>
          <button onClick={goHome} className="btn btn-outline"
            style={{ padding: '8px 16px' }}>Go home</button>
          <button onClick={signOut} className="btn btn-outline"
            style={{ padding: '8px 16px' }}>Sign out</button>
        </div>
        <div style={{ marginTop: 14, fontSize: 12.5 }}>
          <a href={mail} style={{ color: 'var(--accent)' }}>Email us for help</a>
        </div>
      </div>
    </div>
  );
}

// Marketing pages exist for the website only. Inside the native app they
// would render the dark site chrome (nav, footer, "Get started") around a
// user who is already in the app, so on Capacitor they bounce to "/", which
// RootRouter then resolves to sign-in or the app. The web is unaffected.
function WebOnly({ children }) {
  return isNative() ? <Navigate to="/" replace/> : children;
}
// The mirror image: screens that only make sense inside the native shell.
function NativeOnly({ children }) {
  return isNative() ? children : <Navigate to="/" replace/>;
}

// /campaigns, /workflows, /rewards → /marketing?tab=… (other params kept)
function MarketingRedirect({ tab }) {
  const p = new URLSearchParams(window.location.search);
  p.set('tab', tab);
  return <Navigate to={`/marketing?${p.toString()}`} replace/>;
}

// /goals?task=X → /dashboard?task=X#goals (the Goals & Tasks block lives on
// the dashboard; CommandPalette task hits carry ?task= so keep the query).
function GoalsRedirect() {
  const q = window.location.search || '';
  return <Navigate to={`/dashboard${q}#goals`} replace/>;
}

// Client portal: /me/billing (saved cards, memberships) and /me/orders
// (shop orders) now live on the Payments page. Old links from emails, the
// card-saving return URL (?save=ok) and app 1.0.4 keep working.
function PortalPaymentsRedirect({ hash }) {
  const { search } = useLocation();
  // /me/billing held both cards and memberships: the card-saving return
  // (?save=) goes to the cards, anything else (membership emails) to
  // memberships.
  const to = hash || (new URLSearchParams(search).has('save') ? '#cards' : '#memberships');
  return <Navigate to={{ pathname: '/me/invoices', search, hash: to }} replace/>;
}

// /projects?id=X → /clients?folder=X (Clients opens that folder; there is
// no separate folders view, so no `view` param to carry).
function ProjectsRedirect() {
  const id = new URLSearchParams(window.location.search).get('id');
  return <Navigate to={`/clients${id ? `?folder=${encodeURIComponent(id)}` : ''}`} replace/>;
}

export default function App() {
  // Custom-domain mode: when the app is loaded on a business owner's
  // connected custom domain (not a platform host), the ONLY thing that
  // domain serves is that owner's published site, resolved server-side
  // by host. The dashboard, auth, and marketing live only on the
  // platform domain. /book/:slug stays available so the site's
  // "Book a session" button works on the custom domain too.
  const onCustomDomain = typeof window !== 'undefined'
    && !isPlatformHost(window.location.host);
  if (onCustomDomain) {
    return (
      <Suspense fallback={<RouteFallback client/>}>
        <ErrorBoundary fallback={({ resetError, error }) => <RouteCrash resetError={resetError} error={error}/>}>
          <Routes>
            <Route path="/book/:slug" element={<PublicBooking />} />
            <Route path="/book/:slug/policy" element={<PublicPolicyPage />} />
            <Route path="*"           element={<PublicSite byHost />} />
          </Routes>
        </ErrorBoundary>
      </Suspense>
    );
  }

  return (
    <>
    <GetAppBanner/>
    <Suspense fallback={<RouteFallback/>}>
      <ErrorBoundary fallback={({ resetError, error }) => <RouteCrash resetError={resetError} error={error}/>}>
      <Routes>
        {/* Public marketing landing - also handles "I'm logged in, where to?"
            redirect for authenticated users. */}
        <Route path="/" element={<RootRouter />} />

        {/* Auth - primary entry pages are eager (first paint); the
            secondary flows (forgot/reset/verify) load lazily. */}
        <Route path="/welcome"         element={<NativeOnly><WelcomePage /></NativeOnly>} />
        <Route path="/signin"          element={<EarlyAccessGate mode="signin"><AuthPage mode="signin" /></EarlyAccessGate>} />
        <Route path="/signup"          element={<EarlyAccessGate><AuthPage mode="signup" /></EarlyAccessGate>} />
        {/* Directly-linkable waitlist landing (for marketing/social). "/"
            also renders this for logged-out visitors when launch mode is
            'waitlist' (see RootRouter), which passes the real beta-password
            availability. The direct link shows join only. */}
        <Route path="/waitlist"        element={<WaitlistPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password"  element={<ResetPasswordPage />} />
        <Route path="/verify-email"    element={<VerifyEmailPage />} />
        <Route path="/account-recover" element={<AccountRecoverPage />} />

        {/* Public */}
        <Route path="/book/:slug"      element={<PublicBooking />} />
        <Route path="/book/:slug/policy" element={<PublicPolicyPage />} />
        {/* Shop pages (1.0.6): one location, several independent businesses.
            The invite landing handles signed-out vs signed-in itself. */}
        <Route path="/shop/:slug"      element={<PublicShop />} />
        <Route path="/shops/invite/:token" element={<AcceptShopInvite />} />
        <Route path="/site/:handle"        element={<PublicSite />} />
        <Route path="/site/:handle/:slug"  element={<PublicSite />} />
        <Route path="/sign/:token"     element={<SignPage />} />
        {/* Payment-processor return page for the phone flow (public; Safari
            has no session when the processor sends the owner back). */}
        <Route path="/connected"       element={<ConnectedPage />} />
        <Route path="/invoice/:token"  element={<PublicInvoice />} />
        <Route path="/quote/:token"    element={<PublicQuote />} />
        <Route path="/review/:token"   element={<ReviewPage />} />
        <Route path="/p/:id" element={<PublicProgram />} />

        {/* Embeds - same components rendered inside iframes on the
            owner's external website. embed.js (served from /public)
            handles auto-sizing via postMessage. */}
        <Route path="/embed/book/:slug"    element={<PublicBooking embedded />} />
        <Route path="/embed/contact/:slug" element={<EmbedContact />} />

        {/* Legal (public, no auth) */}
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms"   element={<TermsPage />} />
        <Route path="/do-not-sell" element={<DoNotSellPage />} />

        {/* Marketing - extra public surfaces beyond the home page. */}
        <Route path="/about"       element={<WebOnly><SiteAbout /></WebOnly>} />
        <Route path="/support"     element={<WebOnly><SiteSupport /></WebOnly>} />
        <Route path="/tour"        element={<WebOnly><SiteTour /></WebOnly>} />
        <Route path="/features"    element={<WebOnly><SiteFeatures /></WebOnly>} />
        <Route path="/compare"     element={<Navigate to="/features" replace />} />
        <Route path="/for/:slug"   element={<WebOnly><VerticalPage /></WebOnly>} />
        <Route path="/pricing"     element={<WebOnly><SitePricing /></WebOnly>} />
        <Route path="/vs/:slug"    element={<Navigate to="/features" replace />} />
        <Route path="/security"    element={<WebOnly><SecurityPage /></WebOnly>} />
        <Route path="/mobile"      element={<WebOnly><MobilePage /></WebOnly>} />
        <Route path="/integrations" element={<WebOnly><IntegrationsPage /></WebOnly>} />

        {/* First-run wizard for new owners. Auth-gated but no AppShell so it
            can't get caught in RoleRouter's "redirect un-onboarded users to
            /onboarding" loop. */}
        <Route path="/onboarding"
          element={<RequireAuth><OnboardingPage /></RequireAuth>} />

        {/* Business app shell (auth-gated). RoleRouter sends client-only
            users to /me before the shell renders. Dashboard lives at
            /dashboard so the marketing page can own /. */}
        <Route element={<RequireAuth><RoleRouter><AppShell /></RoleRouter></RequireAuth>}>
          <Route path="/dashboard"  element={<Dashboard />} />
          <Route path="/clients"    element={<Clients />} />
          {/* Projects became Folders inside Clients. Old links keep working. */}
          <Route path="/projects"   element={<ProjectsRedirect />} />
          <Route path="/programs"   element={<ProgramsPage />} />
          <Route path="/calendar"   element={<Calendar />} />
          <Route path="/finance"    element={<Finance />} />
          <Route path="/goals"      element={<GoalsRedirect />} />
          <Route path="/marketing"  element={<Marketing />} />
          <Route path="/workflows"  element={<MarketingRedirect tab="workflows"/>} />
          <Route path="/rewards"    element={<MarketingRedirect tab="rewards"/>} />
          <Route path="/referrals"  element={<Navigate to="/account#referrals" replace/>} />
          <Route path="/reviews"    element={<Reviews />} />
          <Route path="/messages"   element={<Messages />} />
          <Route path="/campaigns"  element={<MarketingRedirect tab="campaigns"/>} />
          <Route path="/documents"  element={<Documents />} />
          <Route path="/website"    element={<Website />} />
          <Route path="/shops"      element={<ShopsPage />} />
          <Route path="/ivy"        element={<IvyPro />} />
          <Route path="/account"    element={<AccountPage />} />
          <Route path="/more"       element={<NativeOnly><MorePage /></NativeOnly>} />
          <Route path="/admin"      element={<AdminPage />} />
        </Route>

        {/* Client portal shell (auth-gated). Anyone can navigate here directly;
            the data they see is filtered by their email / user_id. */}
        {/* Group-chat invite landing - auth required; component itself
            handles the "redirect to /signup with next=..." bounce. */}
        <Route path="/invite/group/:token"
          element={<RequireAuth><ClientPortalProvider><AcceptGroupInvite /></ClientPortalProvider></RequireAuth>} />

        <Route element={<RequireAuth><ClientShell /></RequireAuth>}>
          <Route path="/me"           element={<ClientHome />} />
          <Route path="/me/messages"  element={<ClientMessages />} />
          <Route path="/me/bookings"  element={<ClientBookings />} />
          <Route path="/me/orders"    element={<PortalPaymentsRedirect hash="#receipts" />} />
          <Route path="/me/invoices"  element={<ClientInvoices />} />
          <Route path="/me/documents" element={<ClientDocuments />} />
          <Route path="/me/billing"   element={<PortalPaymentsRedirect />} />
          <Route path="/me/discover"  element={<ClientDiscover />} />
          <Route path="/me/notifications" element={<ClientNotifications />} />
          <Route path="/me/profile"       element={<ClientProfile />} />
          <Route path="/me/programs" element={<ClientPrograms />} />
          <Route path="/me/programs/:id" element={<ClientProgram />} />
          <Route path="/me/programs/:id/lessons/:itemId" element={<ClientLesson />} />
        </Route>

        {/* Helper invite landing (public: the page itself handles signed-out
            vs signed-in) and the helper shell (auth-gated; its own tiny nav). */}
        <Route path="/helper/invite/:token" element={<AcceptHelperInvite />} />
        <Route element={<RequireAuth><HelperShell /></RequireAuth>}>
          <Route path="/helper"          element={<HelperSchedule />} />
          <Route path="/helper/clients"  element={<HelperClients />} />
          <Route path="/helper/messages" element={<HelperMessages />} />
          <Route path="/helper/account"  element={<HelperAccount />} />
        </Route>

        {/* 404 catch-all. Must be last so it only matches when nothing
            else does. Without this, mistyped URLs render a blank
            <Routes/> outlet. */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      </ErrorBoundary>
    </Suspense>
    <ViewToggle/>
    {isNative() && <NativeAppLock/>}
    {isNative() && <LaunchVeil/>}
    {/* Quick actions and ivy:// links from iOS → in-app routes. */}
    {isNative() && <NativeUrlOpens/>}
    {/* "Add Ivy to your home screen" prompts are for Safari visitors. In the
        native app the user is already there, so never mount them. */}
    {!isNative() && <PWAPrompts/>}
    </>
  );
}
