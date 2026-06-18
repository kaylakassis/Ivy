// Shared layout for /privacy and /terms. Plain prose, public, no auth.
// Renderable while logged out - used during signup flow + accessible from
// the footer of every auth page.
import React from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useTweaks } from '../../lib/tweaks.js';

export default function LegalPage({ title, lastUpdated, children }) {
  const [tweaks] = useTweaks();
  return (
    <div className={`app-root dir-${tweaks.direction}`}
      style={{ minHeight: '100vh', padding: '40px 24px 80px', background: 'var(--page)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <Link to="/" style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 24,
          color: 'var(--muted)', fontSize: 13, textDecoration: 'none',
        }}>
          <Icons.Arrow size={13} sw={2} style={{ transform: 'rotate(180deg)' }}/> Back
        </Link>

        <h1 className="page-title" style={{ margin: 0, fontSize: 32 }}>{title}</h1>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
          Last updated: {lastUpdated}
        </div>

        <div style={{
          marginTop: 28, fontSize: 14.5, lineHeight: 1.65, color: 'var(--fg-2)',
        }}>
          {children}
        </div>

        <div style={{
          marginTop: 48, paddingTop: 24, borderTop: '1px solid var(--border)',
          fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 14,
        }}>
          <Link to="/signin" style={{ color: 'inherit', textDecoration: 'none' }}>Sign in</Link>
          <Link to="/signup" style={{ color: 'inherit', textDecoration: 'none' }}>Create account</Link>
          <Link to="/privacy" style={{ color: 'inherit', textDecoration: 'none' }}>Privacy</Link>
          <Link to="/terms" style={{ color: 'inherit', textDecoration: 'none' }}>Terms</Link>
        </div>
      </div>
    </div>
  );
}

export function H2({ children }) {
  return (
    <h2 style={{
      fontSize: 18, fontWeight: 600, marginTop: 28, marginBottom: 10, color: 'var(--fg)',
    }}>{children}</h2>
  );
}

export function P({ children }) {
  return <p style={{ margin: '8px 0' }}>{children}</p>;
}

export function UL({ children }) {
  return <ul style={{ margin: '8px 0 8px 18px', padding: 0 }}>{children}</ul>;
}
