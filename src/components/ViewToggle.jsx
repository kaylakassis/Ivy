// Floating Business ↔ Client view switcher. Mounted at the App root so it
// renders on every route, regardless of which shell is active. Pure URL-based
// — no /api/me dependency that can hide it on slow/failed fetches.
//
// Hidden on routes where view-switching makes no sense:
//   • Marketing landing, sign-in/up, password flows, email verification
//   • Public-link pages (book, sign, invoice, public site)
//   • Onboarding wizard
//   • Legal pages
//
// Going to Business as an unsubscribed user lands them in AppShell, which
// then renders the Paywall — gating lives in one place.
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from './Icons.jsx';

// Anything that's not a logged-in shell route. Conservative allowlist would
// flicker the pill on auth state changes; explicit denylist keeps the pill
// stable as we add new shell routes.
const HIDE_PREFIXES = [
  '/signin', '/signup', '/forgot-password', '/reset-password', '/verify-email',
  '/onboarding',
  '/book/', '/sign/', '/invoice/', '/site/',
  '/privacy', '/terms',
];

export default function ViewToggle() {
  const navigate = useNavigate();
  const location = useLocation();

  // Hide on routes that have no concept of "Business vs Client view".
  if (location.pathname === '/') return null;
  if (HIDE_PREFIXES.some((p) => location.pathname === p || location.pathname.startsWith(p))) {
    return null;
  }

  const onClient = location.pathname === '/me' || location.pathname.startsWith('/me/');
  const view = onClient ? 'client' : 'business';

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
    className="view-toggle"
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
  const Icon = Icons[icon];
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
