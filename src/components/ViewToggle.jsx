// Floating Business ↔ Client view switcher. Bottom-center on every page in
// both shells. Shows only when the user has actual access to the other side
// (an owner can see Client even if they're not a client of any business —
// the empty Discover is harmless — but a client-only user without a
// workspace shouldn't see Business at all).
//
// Pure navigation: clicking "Business" while unsubscribed will land on
// AppShell, which then renders the Paywall modal. That keeps gating logic
// in one place instead of duplicated here.
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from './Icons.jsx';

export default function ViewToggle({ ctx }) {
  const navigate = useNavigate();
  const location = useLocation();

  if (!ctx) return null;
  const { isOwner, isClient } = ctx;

  // No toggle needed for users with only one side. Owner-without-client is
  // still allowed to peek at /me — the directory is universal — so we show
  // the toggle whenever the user owns a workspace, regardless of isClient.
  if (!isOwner && !isClient) return null;
  if (!isOwner && isClient) {
    // Client-only — they can't reach Business, hide the toggle entirely.
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
      bottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)',
      left: '50%', transform: 'translateX(-50%)',
      zIndex: 90,
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
