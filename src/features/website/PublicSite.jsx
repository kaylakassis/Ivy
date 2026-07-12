// Renders the published site at /site/:handle (home) and
// /site/:handle/:slug (sub-pages) - reads from
// /api/website/public/:handle?slug=<slug>.
import React, { useEffect, useState } from 'react';
import { Link, useParams, useLocation } from 'react-router-dom';
import SectionRenderer from './SectionRenderer.jsx';
import { TEMPLATES } from './templates.js';
import { FONT_PAIRS } from './sections.js';
import { api } from '../../lib/api.js';
import EmptyNote from '../../components/EmptyNote.jsx';

// `byHost` mode renders the site for a business owner's connected custom
// domain: there's no /site/:handle in the URL, so the page slug comes
// from the path and the site is resolved server-side by the request
// host (/api/website/by-host). Platform mode (/site/:handle) is unchanged.
export default function PublicSite({ byHost = false }) {
  const params = useParams();
  const location = useLocation();
  const pageSlug = byHost
    ? location.pathname.replace(/^\/+/, '').toLowerCase()
    : (params.slug || '');
  const [site, setSite]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  // On a custom domain the handle isn't in the URL; use the one the
  // server resolved (for titles, nav, the pageview beacon).
  const handle = byHost ? (site?.handle || '') : params.handle;
  // Link base for in-site navigation: empty on a custom domain (links
  // are root-relative, e.g. /about), /site/<handle> on the platform.
  const linkBase = byHost ? '' : `/site/${handle}`;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const qs = pageSlug ? `?slug=${encodeURIComponent(pageSlug)}` : '';
    const url = byHost
      ? `/website/by-host${qs}`
      : `/website/public/${encodeURIComponent(params.handle)}${qs}`;
    api.get(url)
      .then((r) => live && setSite(r.site))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [byHost, params.handle, pageSlug]);

  useEffect(() => {
    if (site) {
      const pageTitle = site.page?.title;
      document.title = pageTitle && pageTitle !== 'Home'
        ? `${pageTitle} · ${site.businessName || handle}`
        : (site.businessName || `${handle} · Ivy`);
    }
  }, [site, handle]);

  // Pageview beacon - the production live site is server-rendered (each
  // /site/:handle[/:slug] is its own SSR request that already beacons), so
  // this only fires on the CSR fallback path; keyed on the page so a
  // client-side sub-page nav is still counted. Best-effort.
  useEffect(() => {
    if (!site) return;
    try {
      const body = JSON.stringify({ slug: pageSlug, referrer: (document.referrer || '').slice(0, 300) });
      const url = `/site/${encodeURIComponent(handle)}/pv`;
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      else fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    } catch { /* ignore */ }
  }, [site, handle, pageSlug]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', background: '#FFFFFF', color: '#85827B',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>
        Loading…
      </div>
    );
  }

  if (error || !site) {
    return (
      <div style={{ minHeight: '100vh', padding: 48, background: '#FFFFFF' }}>
        <div style={{ maxWidth: 560, margin: '80px auto' }}>
          <EmptyNote
            icon="Globe"
            title="Site not found"
            hint={`No published site for "${handle}"${pageSlug ? ` at /${pageSlug}` : ''}.`}
          />
        </div>
      </div>
    );
  }

  const tpl = TEMPLATES[site.template] || TEMPLATES.clean;
  // Build CSS-var bag with optional font-pair override.
  const vars = { ...tpl.vars };
  if (site.fontPair && FONT_PAIRS[site.fontPair]) {
    vars['--site-font-display'] = FONT_PAIRS[site.fontPair].display;
    vars['--site-font-body']    = FONT_PAIRS[site.fontPair].body;
  }
  const pageSections = site.page?.sections || [];
  const visible = pageSections.filter((s) => s.visible);
  const nav = Array.isArray(site.nav) ? site.nav : [];

  return (
    <div style={{
      ...vars,
      minHeight: '100vh',
      background: 'var(--site-bg)',
      color: 'var(--site-fg)',
      fontFamily: 'var(--site-font-body)',
    }}>
      {/* Owner-supplied CSS. Scoped within this wrapper by sitting
          inside the var()'d shell - there's no `scope` attr in CSS yet
          but the variable wrapper is sufficient for theme isolation. */}
      {site.customCss && <style>{site.customCss}</style>}

      {/* Site-wide nav strip - only renders for multi-page sites. */}
      {nav.length > 1 && (
        <PublicNav handle={handle} linkBase={linkBase} nav={nav} currentSlug={pageSlug}
          businessName={site.businessName}/>
      )}

      {visible.map((section) => (
        <SectionRenderer key={section.id} section={section} handle={site.handle} />
      ))}

      {/* Parity with the SSR renderer (siteHtml.js) for the CSR fallback. */}
      <StickyCta cfg={site.stickyCta} />
      <ExitIntent cfg={site.exitIntentPopup} />
    </div>
  );
}

// Fixed promo bar - mirrors renderStickyCta in siteHtml.js.
function StickyCta({ cfg }) {
  if (!cfg || !cfg.enabled || !cfg.text) return null;
  const pos = cfg.position === 'top' ? { top: 0 } : { bottom: 0 };
  return (
    <a href={cfg.link || '#'} style={{
      position: 'fixed', left: 0, right: 0, ...pos, zIndex: 9000,
      padding: '14px 24px', background: 'var(--site-accent)', color: 'var(--site-accent-ink)',
      textAlign: 'center', fontWeight: 600, textDecoration: 'none',
    }}>{cfg.text} →</a>
  );
}

// Exit-intent modal - mirrors renderExitIntent in siteHtml.js. Shows once
// per session on first upward mouse-exit.
function ExitIntent({ cfg }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!cfg || !cfg.enabled || !cfg.headline) return undefined;
    try { if (sessionStorage.getItem('ivy-exit-shown')) return undefined; } catch { /* ignore */ }
    const onLeave = (e) => {
      if (e.clientY < 10) {
        setShow(true);
        try { sessionStorage.setItem('ivy-exit-shown', '1'); } catch { /* ignore */ }
        document.removeEventListener('mouseleave', onLeave);
      }
    };
    document.addEventListener('mouseleave', onLeave);
    return () => document.removeEventListener('mouseleave', onLeave);
  }, [cfg]);
  if (!cfg || !cfg.enabled || !cfg.headline || !show) return null;
  return (
    <div onClick={() => setShow(false)} style={{
      position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        maxWidth: 480, background: 'var(--site-bg)', color: 'var(--site-fg)',
        padding: 32, borderRadius: 'var(--site-radius)', border: '1px solid var(--site-border)', position: 'relative',
      }}>
        <button onClick={() => setShow(false)} aria-label="Close" style={{
          position: 'absolute', top: 10, right: 14, background: 'transparent',
          border: 0, fontSize: 20, color: 'var(--site-muted)', cursor: 'pointer',
        }}>×</button>
        <h3 style={{ margin: 0, fontFamily: 'var(--site-font-display)', fontSize: 24 }}>{cfg.headline}</h3>
        {cfg.sub && <p style={{ margin: '10px 0 0', color: 'var(--site-fg-2)', lineHeight: 1.55 }}>{cfg.sub}</p>}
        {cfg.cta && (
          <p style={{ margin: '20px 0 0' }}>
            <a href={cfg.ctaLink || '#'} style={{
              display: 'inline-block', padding: '12px 22px', background: 'var(--site-accent)',
              color: 'var(--site-accent-ink)', borderRadius: 'var(--site-radius)', textDecoration: 'none', fontWeight: 600,
            }}>{cfg.cta} →</a>
          </p>
        )}
      </div>
    </div>
  );
}

// Top-of-page nav for multi-page sites. Sticky, transparent over the
// hero, gains a backdrop when scrolled. Page links use React Router so
// transitions stay client-side.
function PublicNav({ handle, linkBase = `/site/${handle}`, nav, currentSlug, businessName }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', gap: 24,
      padding: '14px 64px',
      background: scrolled ? 'color-mix(in srgb, var(--site-bg) 92%, transparent)' : 'transparent',
      backdropFilter: scrolled ? 'blur(8px)' : 'none',
      WebkitBackdropFilter: scrolled ? 'blur(8px)' : 'none',
      borderBottom: scrolled ? '1px solid var(--site-border)' : '1px solid transparent',
      transition: 'background 0.2s, border-color 0.2s',
    }}>
      <Link to={linkBase || '/'} style={{
        fontFamily: 'var(--site-font-display)', fontSize: 20, fontWeight: 550,
        color: 'var(--site-fg)', textDecoration: 'none', letterSpacing: '-0.015em',
      }}>{businessName || handle}</Link>
      <div style={{ flex: 1 }}/>
      <div style={{ display: 'flex', gap: 22 }}>
        {nav.map((p) => {
          const active = (p.slug || '') === (currentSlug || '');
          return (
            <Link key={p.slug || 'home'}
              to={p.slug ? `${linkBase}/${p.slug}` : (linkBase || '/')}
              style={{
                fontSize: 14, color: active ? 'var(--site-accent)' : 'var(--site-fg-2)',
                textDecoration: 'none', fontWeight: active ? 600 : 500,
              }}>{p.title || (p.slug ? p.slug : 'Home')}</Link>
          );
        })}
      </div>
    </nav>
  );
}
