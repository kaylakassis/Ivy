// Floating Business ↔ Client view switcher. Mounted at the App root so it
// renders on every route, regardless of which shell is active. Pure URL-based
// - no /api/me dependency that can hide it on slow/failed fetches.
//
// Hidden on:
//   • Routes where view-switching makes no sense (marketing landing,
//     sign-in/up, password flows, email verification, public-link pages,
//     onboarding wizard, legal pages - see HIDE_PREFIXES below).
//   • Mobile viewport - the floating pill kept covering action sheets
//     and bottom-row controls. The same Business / Client switch is
//     surfaced inside the hamburger drawer on phones (see
//     MobileDrawer.jsx → renderViewSwitch).
//
// Going to Business as an unsubscribed user lands them in AppShell, which
// then renders the Paywall - gating lives in one place.
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from './Icons.jsx';
import { useViewport } from '../lib/viewport.js';

// Routes that put a composer at the bottom edge of the viewport (chat-style
// surfaces). The default centered-and-anchored-to-bottom pill collides with
// the composer on these - Send button to the right, textarea in the middle.
// Bumping `bottom` higher via .view-toggle-raised lifts the pill clear of
// the composer without changing layout anywhere else.
const RAISE_PREFIXES = [
  '/messages',     // owner: Direct + Groups
  '/me/messages',  // client: 1:1 with each business
  '/me/groups',    // client: group chats
  '/me/dms',       // client: client-to-client DMs
  '/ivy',          // Ivy Pro chat
];

// Anything that's not a logged-in shell route. Conservative allowlist would
// flicker the pill on auth state changes; explicit denylist keeps the pill
// stable as we add new shell routes.
const HIDE_PREFIXES = [
  '/signin', '/signup', '/forgot-password', '/reset-password', '/verify-email',
  '/onboarding',
  '/book/', '/sign/', '/invoice/', '/quote/', '/review/', '/site/', '/embed/',
  '/privacy', '/terms',
  // Marketing pages: the floating pill overlapped page content (e.g. the
  // pricing card) and confused logged-out visitors. The Business/Client
  // switch is surfaced on marketing pages via the AudienceToggle in the
  // nav/footer instead (MarketingShell.jsx). The floating pill stays for
  // the logged-in app shells (dashboard, /me) where switching is the point.
  '/pricing', '/blog', '/about', '/security', '/integrations', '/mobile',
  '/for/', '/vs/',
];

export default function ViewToggle() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useViewport();

  // Hide on routes that have no concept of "Business vs Client view".
  if (location.pathname === '/') return null;
  if (HIDE_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(p))) {
    return null;
  }
  // Mobile: surfaced in the hamburger drawer instead, so the floating
  // pill doesn't sit on top of action sheets and bottom-row controls.
  if (isMobile) return null;

  const onClient = location.pathname === '/me' || location.pathname.startsWith('/me/');
  const view = onClient ? 'client' : 'business';
  // On chat-style routes the default bottom-center position lands the
  // pill directly on top of the composer. Add a class so global.css can
  // lift it above the composer without affecting any other route.
  const raised = RAISE_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(p + '/') || location.pathname === p);

  const go = (target) => {
    if (target === view) return;
    navigate(target === 'client' ? '/me' : '/');
  };

  return (
    <div role="group" aria-label="View switcher" style={{
      position: 'fixed',
      // `bottom` lives in CSS (.view-toggle) so the
      // `body.has-mobile-nav .view-toggle` media-query override can lift
      // the pill above the bottom nav. Setting it inline here would
      // override the CSS and the pill would sit ON TOP of the nav.
      left: '50%', transform: 'translateX(-50%)',
      // Sits above the Paywall (z-index 200) so a paywalled owner can
      // always escape back to the free client portal.
      zIndex: 250,
      display: 'flex', gap: 4, padding: 4,
      background: 'var(--surface)', border: '1px solid var(--border-strong)',
      borderRadius: 999, boxShadow: 'var(--shadow)',
    }}
    className={'view-toggle' + (raised ? ' view-toggle-raised' : '')}
    >
      <ToggleButton
        active={view === 'business'}
        onClick={() => go('business')}
        icon="Trending"
        label="Business"
      />
      <ToggleButton
        active={view === 'client'}
        onClick={() => go('client')}
        icon="Users"
        label="Client"
        sub="free"
      />
    </div>
  );
}

function ToggleButton({ active, onClick, icon, label, sub }) {
  const Icon = Icons[icon] || Icons.More;
  return (
    <button type="button" onClick={onClick} aria-pressed={active} style={{
      display: 'inline-flex', alignItems: 'center', gap: 7,
      padding: '7px 14px', borderRadius: 999, border: 0,
      background: active ? 'var(--fg)' : 'transparent',
      color: active ? 'var(--page)' : 'var(--fg-2)',
      fontWeight: 600, fontSize: 13, cursor: 'pointer',
      transition: 'background 0.15s ease',
    }}>
      {Icon && <Icon size={13} sw={active ? 2 : 1.7}/>}
      {label}
      {sub && (
        <span style={{
          padding: '1px 6px', borderRadius: 99, fontSize: 9.5, fontWeight: 700,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          background: active ? 'rgba(255,255,255,0.18)' : 'var(--accent-soft)',
          color: active ? 'inherit' : 'var(--accent)',
        }}>{sub}</span>
      )}
    </button>
  );
}
