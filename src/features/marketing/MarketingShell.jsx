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
import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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

// Mobile hamburger menu for the marketing nav. On desktop the inline
// nav links show and this button is hidden (CSS .marketing-hamburger);
// on mobile (≤720px) the inline links hide via .marketing-nav-secondary
// and this is the ONLY way to reach the nav - previously there was no
// hamburger at all, so the links only appeared in the footer.
//
// `extra` is an optional list of { label, href } in-page anchors (the
// home page passes Features / Compare / FAQ); cross-site route links
// are always included.
export function MarketingMobileMenu({ extra = [] }) {
  const [open, setOpen] = useState(false);

  // Lock body scroll while the sheet is open + close on Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const routeLinks = [
    { label: 'Pricing', to: '/pricing' },
    { label: 'Blog',    to: '/blog' },
    { label: 'About',   to: '/about' },
  ];

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        className="marketing-hamburger btn btn-ghost"
        onClick={() => setOpen(true)}
        style={{ padding: 8, color: 'var(--fg)' }}>
        <Icons.Menu size={20} sw={1.8}/>
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 60,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex', justifyContent: 'flex-end',
          }}>
          <nav
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(82vw, 320px)', height: '100%',
              background: 'var(--surface)', borderLeft: '1px solid var(--border)',
              padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 4,
              boxShadow: '-20px 0 40px -12px rgba(0,0,0,0.3)',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
              <span style={{
                fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 18,
                letterSpacing: '-0.015em', flex: 1,
              }}>Ivy OS</span>
              <button type="button" aria-label="Close menu" className="btn btn-ghost"
                onClick={() => setOpen(false)} style={{ padding: 6 }}>
                <Icons.X size={18}/>
              </button>
            </div>

            {extra.map((it) => (
              <a key={it.href} href={it.href} onClick={() => setOpen(false)}
                style={menuItem}>{it.label}</a>
            ))}
            {routeLinks.map((it) => (
              <Link key={it.to} to={it.to} onClick={() => setOpen(false)}
                style={menuItem}>{it.label}</Link>
            ))}

            <div style={{ height: 1, background: 'var(--border)', margin: '8px 0' }}/>
            <Link to="/signin" onClick={() => setOpen(false)} style={menuItem}>Sign in</Link>
            <Link to="/signup" onClick={() => setOpen(false)}
              className="btn btn-primary"
              style={{ marginTop: 6, padding: '12px 14px', justifyContent: 'center', fontSize: 14 }}>
              Get started <Icons.Arrow size={13} sw={2}/>
            </Link>
          </nav>
        </div>
      )}
    </>
  );
}

const menuItem = {
  display: 'block', padding: '11px 12px', borderRadius: 8,
  fontSize: 15, color: 'var(--fg)', textDecoration: 'none',
};

// Business / Client audience toggle for the marketing site. Lets a
// visitor flip the home page between the owner story and the client
// story (the home reads ?for=client). Navigates via URL so it works
// identically from the home page AND from the footer of any sub-page
// (which deep-links back to the home in the chosen mode). This replaces
// the floating ViewToggle pill that used to overlap marketing content.
export function AudienceToggle({ size = 'md' }) {
  const [params] = useSearchParams();
  const audience = params.get('for') === 'client' ? 'client' : 'business';
  const pad = size === 'sm' ? '5px 12px' : '7px 14px';
  const fs  = size === 'sm' ? 12 : 13;
  return (
    <div role="group" aria-label="Audience" style={{
      display: 'inline-flex', gap: 4, padding: 4,
      background: 'var(--surface)', border: '1px solid var(--border-strong)',
      borderRadius: 999,
    }}>
      <AudienceBtn to="/" active={audience === 'business'} icon="Trending" label="For owners" pad={pad} fs={fs}/>
      <AudienceBtn to="/?for=client" active={audience === 'client'} icon="Users" label="For clients" pad={pad} fs={fs} freeBadge/>
    </div>
  );
}

function AudienceBtn({ to, active, icon, label, pad, fs, freeBadge }) {
  const Icon = Icons[icon] || Icons.More;
  return (
    <Link to={to} aria-pressed={active} style={{
      display: 'inline-flex', alignItems: 'center', gap: 7,
      padding: pad, borderRadius: 999, textDecoration: 'none',
      background: active ? 'var(--fg)' : 'transparent',
      color: active ? 'var(--page)' : 'var(--fg-2)',
      fontWeight: 600, fontSize: fs,
    }}>
      <Icon size={fs} sw={active ? 2 : 1.7}/>
      {label}
      {freeBadge && (
        <span style={{
          padding: '1px 6px', borderRadius: 99, fontSize: 9.5, fontWeight: 700,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          background: active ? 'rgba(255,255,255,0.18)' : 'var(--accent-soft)',
          color: active ? 'inherit' : 'var(--accent)',
        }}>free</span>
      )}
    </Link>
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
          }}>Ivy OS</span>
        </Link>
        <div style={{ flex: 1 }}/>
        <Link to="/pricing" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Pricing</Link>
        <Link to="/blog" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>Blog</Link>
        <Link to="/about" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 12px', fontSize: 13, color: 'var(--fg-2)' }}>About</Link>
        <Link to="/signin" className="btn btn-ghost marketing-nav-secondary"
          style={{ padding: '8px 14px', fontSize: 13, color: 'var(--fg-2)' }}>Sign in</Link>
        <Link to="/signup" className="btn btn-primary marketing-nav-secondary"
          style={{ padding: '8px 14px', fontSize: 13 }}>Get started</Link>
        <MarketingMobileMenu/>
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
        maxWidth: 1100, margin: '0 auto 16px',
        display: 'flex', justifyContent: 'center',
      }}>
        <AudienceToggle size="sm"/>
      </div>
      <div style={{
        maxWidth: 1100, margin: '0 auto',
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      }}>
        <Link to="/" style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', textDecoration: 'none' }}>
          Ivy OS
        </Link>
        <div style={{ flex: 1 }}/>
        <div style={{ display: 'flex', gap: 18, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <Link to="/pricing" style={{ color: 'inherit', textDecoration: 'none' }}>Pricing</Link>
          <Link to="/blog" style={{ color: 'inherit', textDecoration: 'none' }}>Blog</Link>
          <Link to="/security" style={{ color: 'inherit', textDecoration: 'none' }}>Security</Link>
          <Link to="/integrations" style={{ color: 'inherit', textDecoration: 'none' }}>Integrations</Link>
          <Link to="/mobile" style={{ color: 'inherit', textDecoration: 'none' }}>Mobile</Link>
          <Link to="/about" style={{ color: 'inherit', textDecoration: 'none' }}>About</Link>
          <Link to="/privacy" style={{ color: 'inherit', textDecoration: 'none' }}>Privacy</Link>
          <Link to="/terms" style={{ color: 'inherit', textDecoration: 'none' }}>Terms</Link>
          <Link to="/do-not-sell" style={{ color: 'inherit', textDecoration: 'none' }}>Do Not Sell My Info</Link>
          <Link to="/signin" style={{ color: 'inherit', textDecoration: 'none' }}>Sign in</Link>
        </div>
      </div>
      <div style={{
        maxWidth: 1100, margin: '12px auto 0',
        fontSize: 11, color: 'var(--muted-2)', textAlign: 'center',
      }}>
        © {new Date().getFullYear()} Ivy OS.
      </div>
    </footer>
  );
}
