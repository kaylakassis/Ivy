// Shared marketing-page shell + chrome (nav + footer).
//
// MarketingShell wraps content in the themed root (`app-root
// dir-<direction>`) so the brand CSS variables (--page, --accent,
// --fg, --surface, etc.) actually resolve. Those variables are only
// defined under `.dir-calm` / `.dir-bold` (styles/tokens.css); a page
// that forgets the wrapper renders plain white/black, off-brand from
// the home page.
//
// SimpleNav + SimpleFooter live here too. They used to live in
// ChangelogPage, which has been removed; every non-home marketing
// page imports the chrome from this module now.
import React from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useTweaks } from '../../lib/tweaks.js';

export default function MarketingShell({ children, style }) {
  const [tweaks] = useTweaks();
  return (
    <div
      className={`app-root dir-${tweaks.direction}`}
      style={{ minHeight: '100vh', background: 'var(--page)', color: 'var(--fg)', ...style }}
    >
      {children}
    </div>
  );
}

// Minimal nav + footer for non-home marketing pages. Same brand, fewer links.
export function SimpleNav() {
  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 30,
      background: 'color-mix(in srgb, var(--page) 92%, transparent)',
      backdropFilter: 'saturate(180%) blur(8px)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{
        maxWidth: 1100, margin: '0 auto', padding: '14px 20px',
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}>
        <Link to="/" style={{
          display: 'flex', alignItems: 'center', gap: 10,
          textDecoration: 'none', color: 'inherit',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'var(--accent)', color: 'var(--accent-ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icons.Logo size={20} color="currentColor"/>
          </div>
          <span style={{
            fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 19,
            letterSpacing: '-0.015em',
          }}>thryve</span>
        </Link>
        <div style={{ flex: 1 }}/>
        <Link to="/pricing" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Pricing</Link>
        <Link to="/blog" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Blog</Link>
        <Link to="/about" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>About</Link>
        <Link to="/signin" className="btn btn-ghost"
          style={{ padding: '8px 14px', fontSize: 13, color: 'var(--fg-2)' }}>Sign in</Link>
        <Link to="/signup" className="btn btn-primary"
          style={{ padding: '8px 14px', fontSize: 13 }}>Get started</Link>
      </div>
    </header>
  );
}

export function SimpleFooter() {
  return (
    <footer style={{
      borderTop: '1px solid var(--border)',
      padding: '24px 24px 40px', marginTop: 24,
    }}>
      <div style={{
        maxWidth: 1100, margin: '0 auto',
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      }}>
        <Link to="/" style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', textDecoration: 'none' }}>
          THRYVE
        </Link>
        <div style={{ flex: 1 }}/>
        <div style={{ display: 'flex', gap: 18, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <Link to="/pricing" style={{ color: 'inherit', textDecoration: 'none' }}>Pricing</Link>
          <Link to="/blog" style={{ color: 'inherit', textDecoration: 'none' }}>Blog</Link>
          <Link to="/security" style={{ color: 'inherit', textDecoration: 'none' }}>Security</Link>
          <Link to="/integrations" style={{ color: 'inherit', textDecoration: 'none' }}>Integrations</Link>
          <Link to="/mobile" style={{ color: 'inherit', textDecoration: 'none' }}>Mobile</Link>
          <Link to="/roadmap" style={{ color: 'inherit', textDecoration: 'none' }}>Roadmap</Link>
          <Link to="/about" style={{ color: 'inherit', textDecoration: 'none' }}>About</Link>
          <Link to="/privacy" style={{ color: 'inherit', textDecoration: 'none' }}>Privacy</Link>
          <Link to="/terms" style={{ color: 'inherit', textDecoration: 'none' }}>Terms</Link>
          <Link to="/signin" style={{ color: 'inherit', textDecoration: 'none' }}>Sign in</Link>
        </div>
      </div>
      <div style={{
        maxWidth: 1100, margin: '12px auto 0',
        fontSize: 11, color: 'var(--muted-2)', textAlign: 'center',
      }}>
        © {new Date().getFullYear()} THRYVE Business OS.
      </div>
    </footer>
  );
}
