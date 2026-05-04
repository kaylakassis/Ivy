// Floating Business ↔ Client view switcher. Bottom-center on every page in
// both shells. Always rendered — RequireAuth already guarantees a signed-in
// user before either shell mounts, so we don't need to second-guess it
// here. Earlier revisions gated on a /api/me round-trip; if that request
// was slow or errored, the pill silently disappeared. Pure URL-based now.
//
// Going to Business as an unsubscribed user lands them in AppShell, which
// then renders the Paywall — gating lives in one place.
// Going to Client always works (the portal is universal and free).
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from './Icons.jsx';

export default function ViewToggle() {
  const navigate = useNavigate();
  const location = useLocation();

  const onClient = location.pathname === '/me' || location.pathname.startsWith('/me/');
  const view = onClient ? 'client' : 'business';

  const go = (target) => {
    if (target === view) return;
    navigate(target === 'client' ? '/me' : '/');
  };

  return (
    <div role="group" aria-label="View switcher" style={{
      position: 'fixed',
      bottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)',
      left: '50%', transform: 'translateX(-50%)',
      // Sits above the Paywall (z-index 200) so a paywalled owner can
      // always escape back to the free client portal.
      zIndex: 250,
      display: 'flex', gap: 4, padding: 4,
      background: 'var(--surface)', border: '1px solid var(--border-strong)',
      borderRadius: 999, boxShadow: 'var(--shadow)',
    }}
    // Bottom-nav on mobile sits at the bottom; nudge the pill up so it
    // doesn't collide. Body class set by both shells.
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
