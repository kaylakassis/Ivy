// Top-level route table. Most route components are lazy-loaded so a
// fresh visit to /signin doesn't pull the entire business app + admin
// console into the initial bundle. Eager:
//   AuthPage, AppShell, ClientShell, RootRouter, RequireAuth, RoleRouter
//   — first-paint critical or used by every authenticated request.
// Everything else loads on demand inside <Suspense>; the fallback is a
// minimal centered spinner so navigation never feels stuck.
import React, { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import AppShell from './components/layout/AppShell.jsx';
import ViewToggle from './components/ViewToggle.jsx';
import RequireAuth from './features/auth/RequireAuth.jsx';
import AuthPage from './features/auth/AuthPage.jsx';
import EarlyAccessGate from './features/auth/EarlyAccessGate.jsx';
import RoleRouter from './features/auth/RoleRouter.jsx';
import RootRouter from './features/marketing/RootRouter.jsx';
import ClientShell from './features/client/ClientShell.jsx';
import { ErrorBoundary } from './lib/monitoring.js';

// ── Lazy: business app pages ──
const Dashboard   = lazy(() => import('./features/dashboard/Dashboard.jsx'));
const Clients     = lazy(() => import('./features/clients/Clients.jsx'));
const Projects    = lazy(() => import('./features/projects/Projects.jsx'));
const Calendar    = lazy(() => import('./features/calendar/Calendar.jsx'));
const Finance     = lazy(() => import('./features/finance/Finance.jsx'));
const Goals       = lazy(() => import('./features/goals/Goals.jsx'));
const Workflows   = lazy(() => import('./features/workflows/Workflows.jsx'));
const Rewards     = lazy(() => import('./features/rewards/Rewards.jsx'));
const Messages    = lazy(() => import('./features/messages/Messages.jsx'));
const Documents   = lazy(() => import('./features/documents/Documents.jsx'));
const Website     = lazy(() => import('./features/website/Website.jsx'));
const IvyPro      = lazy(() => import('./features/ivy/IvyPro.jsx'));
const AccountPage = lazy(() => import('./features/account/AccountPage.jsx'));
const AdminPage   = lazy(() => import('./features/admin/AdminPage.jsx'));

// ── Lazy: client portal ──
const ClientHome      = lazy(() => import('./features/client/ClientHome.jsx'));
const ClientMessages  = lazy(() => import('./features/client/ClientMessages.jsx'));
const ClientBookings  = lazy(() => import('./features/client/ClientBookings.jsx'));
const ClientInvoices  = lazy(() => import('./features/client/ClientInvoices.jsx'));
const ClientDocuments = lazy(() => import('./features/client/ClientDocuments.jsx'));
const ClientBilling   = lazy(() => import('./features/client/ClientBilling.jsx'));
const ClientDiscover  = lazy(() => import('./features/client/ClientDiscover.jsx'));

// ── Lazy: secondary auth flows + onboarding ──
const ForgotPasswordPage = lazy(() => import('./features/auth/ForgotPasswordPage.jsx'));
const ResetPasswordPage  = lazy(() => import('./features/auth/ResetPasswordPage.jsx'));
const VerifyEmailPage    = lazy(() => import('./features/auth/VerifyEmailPage.jsx'));
const OnboardingPage     = lazy(() => import('./features/onboarding/OnboardingPage.jsx'));

// ── Lazy: public surfaces (often a fresh visit's first hit) ──
const PublicBooking = lazy(() => import('./features/calendar/PublicBooking.jsx'));
const PublicSite    = lazy(() => import('./features/website/PublicSite.jsx'));
const EmbedContact  = lazy(() => import('./features/embed/EmbedContact.jsx'));
const SignPage      = lazy(() => import('./features/documents/SignPage.jsx'));
const PublicInvoice = lazy(() => import('./features/finance/PublicInvoice.jsx'));
const PublicQuote   = lazy(() => import('./features/finance/PublicQuote.jsx'));
const ReviewPage    = lazy(() => import('./features/reviews/ReviewPage.jsx'));
const PrivacyPage   = lazy(() => import('./features/legal/PrivacyPage.jsx'));
const TermsPage     = lazy(() => import('./features/legal/TermsPage.jsx'));
const ChangelogPage = lazy(() => import('./features/marketing/ChangelogPage.jsx'));
const AboutPage     = lazy(() => import('./features/marketing/AboutPage.jsx'));
const VerticalPage  = lazy(() => import('./features/marketing/VerticalPage.jsx'));
const PricingPage     = lazy(() => import('./features/marketing/PricingPage.jsx'));
const ComparePage     = lazy(() => import('./features/marketing/ComparePage.jsx'));
const BlogIndex       = lazy(() => import('./features/marketing/BlogIndex.jsx'));
const BlogPostPage    = lazy(() => import('./features/marketing/BlogPostPage.jsx'));
const SecurityPage    = lazy(() => import('./features/marketing/SecurityPage.jsx'));
const MobilePage      = lazy(() => import('./features/marketing/MobilePage.jsx'));
const IntegrationsPage = lazy(() => import('./features/marketing/IntegrationsPage.jsx'));
const RoadmapPage     = lazy(() => import('./features/marketing/RoadmapPage.jsx'));

// Centered, low-key spinner. Avoids blank-flash but doesn't fight the
// destination page's own loader for visual real estate. Lives inside
// the route so it only renders during chunk fetches.
function RouteFallback() {
  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--muted)', fontSize: 13,
    }}>
      <div style={{
        width: 12, height: 12, borderRadius: 99,
        border: '2px solid var(--border)',
        borderTopColor: 'var(--accent)',
        animation: 'thryve-spin 0.7s linear infinite',
      }}/>
    </div>
  );
}

// Page-scoped failure card. Surface enough info that a user can
// recover OR get unstuck:
//   • Show the actual error message (it's their session; safe to show).
//   • "Try again" — resets the boundary.
//   • "Go home"  — hard navigate to /, clears the route, clears any
//     localStorage onboarding gate so a fresh load isn't trapped.
//   • "Sign out" — clears auth cookie and bounces.
//   • Email link with the error pre-filled.
function RouteCrash({ resetError, error }) {
  const msg = (error && (error.message || String(error))) || 'unknown';
  const goHome = () => {
    try {
      // If the user has a stale onboarding-skip flag from a prior session
      // it could be sending them through a broken redirect chain. Clear
      // it on hard recovery.
      localStorage.removeItem('thryve_skip_onboarding_until');
    } catch { /* private mode */ }
    window.location.href = '/';
  };
  const signOut = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    try { localStorage.clear(); } catch {}
    window.location.href = '/';
  };
  const mail = `mailto:hello@getthryve.ai?subject=${encodeURIComponent('Error on THRYVE')}&body=${encodeURIComponent(`I hit an error: ${msg}\n\nURL: ${typeof window !== 'undefined' ? window.location.href : ''}\n\n`)}`;
  return (
    <div style={{
      minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
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

export default function App() {
  return (
    <>
    <Suspense fallback={<RouteFallback/>}>
      <ErrorBoundary fallback={({ resetError, error }) => <RouteCrash resetError={resetError} error={error}/>}>
      <Routes>
        {/* Public marketing landing — also handles "I'm logged in, where to?"
            redirect for authenticated users. */}
        <Route path="/" element={<RootRouter />} />

        {/* Auth — primary entry pages are eager (first paint); the
            secondary flows (forgot/reset/verify) load lazily. */}
        <Route path="/signin"          element={<EarlyAccessGate><AuthPage mode="signin" /></EarlyAccessGate>} />
        <Route path="/signup"          element={<EarlyAccessGate><AuthPage mode="signup" /></EarlyAccessGate>} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password"  element={<ResetPasswordPage />} />
        <Route path="/verify-email"    element={<VerifyEmailPage />} />

        {/* Public */}
        <Route path="/book/:slug"      element={<PublicBooking />} />
        <Route path="/site/:handle"        element={<PublicSite />} />
        <Route path="/site/:handle/:slug"  element={<PublicSite />} />
        <Route path="/sign/:token"     element={<SignPage />} />
        <Route path="/invoice/:token"  element={<PublicInvoice />} />
        <Route path="/quote/:token"    element={<PublicQuote />} />
        <Route path="/review/:token"   element={<ReviewPage />} />

        {/* Embeds — same components rendered inside iframes on the
            owner's external website. embed.js (served from /public)
            handles auto-sizing via postMessage. */}
        <Route path="/embed/book/:slug"    element={<PublicBooking embedded />} />
        <Route path="/embed/contact/:slug" element={<EmbedContact />} />

        {/* Legal (public, no auth) */}
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms"   element={<TermsPage />} />

        {/* Marketing — extra public surfaces beyond the home page. */}
        <Route path="/changelog"   element={<ChangelogPage />} />
        <Route path="/about"       element={<AboutPage />} />
        <Route path="/for/:slug"   element={<VerticalPage />} />
        <Route path="/pricing"     element={<PricingPage />} />
        <Route path="/vs/:slug"    element={<ComparePage />} />
        <Route path="/blog"        element={<BlogIndex />} />
        <Route path="/blog/:slug"  element={<BlogPostPage />} />
        <Route path="/security"    element={<SecurityPage />} />
        <Route path="/mobile"      element={<MobilePage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/roadmap"     element={<RoadmapPage />} />

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
          <Route path="/projects"   element={<Projects />} />
          <Route path="/calendar"   element={<Calendar />} />
          <Route path="/finance"    element={<Finance />} />
          <Route path="/goals"      element={<Goals />} />
          <Route path="/workflows"  element={<Workflows />} />
          <Route path="/rewards"    element={<Rewards />} />
          <Route path="/messages"   element={<Messages />} />
          <Route path="/documents"  element={<Documents />} />
          <Route path="/website"    element={<Website />} />
          <Route path="/ivy"        element={<IvyPro />} />
          <Route path="/account"    element={<AccountPage />} />
          <Route path="/admin"      element={<AdminPage />} />
        </Route>

        {/* Client portal shell (auth-gated). Anyone can navigate here directly;
            the data they see is filtered by their email / user_id. */}
        <Route element={<RequireAuth><ClientShell /></RequireAuth>}>
          <Route path="/me"           element={<ClientHome />} />
          <Route path="/me/messages"  element={<ClientMessages />} />
          <Route path="/me/bookings"  element={<ClientBookings />} />
          <Route path="/me/invoices"  element={<ClientInvoices />} />
          <Route path="/me/documents" element={<ClientDocuments />} />
          <Route path="/me/billing"   element={<ClientBilling />} />
          <Route path="/me/discover"  element={<ClientDiscover />} />
        </Route>
      </Routes>
      </ErrorBoundary>
    </Suspense>
    <ViewToggle/>
    </>
  );
}
