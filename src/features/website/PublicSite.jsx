// Renders the published site at /site/:handle (home) and
// /site/:handle/:slug (sub-pages) — reads from
// /api/website/public/:handle?slug=<slug>.
import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import SectionRenderer from './SectionRenderer.jsx';
import { TEMPLATES } from './templates.js';
import { FONT_PAIRS } from './sections.js';
import { api } from '../../lib/api.js';
import EmptyNote from '../../components/EmptyNote.jsx';

export default function PublicSite() {
  const { handle, slug } = useParams();
  const pageSlug = slug || '';
  const [site, setSite]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const url = `/website/public/${encodeURIComponent(handle)}` + (pageSlug ? `?slug=${encodeURIComponent(pageSlug)}` : '');
    api.get(url)
      .then((r) => live && setSite(r.site))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [handle, pageSlug]);

  useEffect(() => {
    if (site) {
      const pageTitle = site.page?.title;
      document.title = pageTitle && pageTitle !== 'Home'
        ? `${pageTitle} · ${site.businessName || handle}`
        : (site.businessName || `${handle} · thryve`);
    }
  }, [site, handle]);

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
          inside the var()'d shell — there's no `scope` attr in CSS yet
          but the variable wrapper is sufficient for theme isolation. */}
      {site.customCss && <style>{site.customCss}</style>}

      {/* Site-wide nav strip — only renders for multi-page sites. */}
      {nav.length > 1 && (
        <PublicNav handle={handle} nav={nav} currentSlug={pageSlug}
          businessName={site.businessName}/>
      )}

      {visible.map((section) => (
        <SectionRenderer key={section.id} section={section} handle={site.handle} />
      ))}
    </div>
  );
}

// Top-of-page nav for multi-page sites. Sticky, transparent over the
// hero, gains a backdrop when scrolled. Page links use React Router so
// transitions stay client-side.
function PublicNav({ handle, nav, currentSlug, businessName }) {
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
      <Link to={`/site/${handle}`} style={{
        fontFamily: 'var(--site-font-display)', fontSize: 20, fontWeight: 550,
        color: 'var(--site-fg)', textDecoration: 'none', letterSpacing: '-0.015em',
      }}>{businessName || handle}</Link>
      <div style={{ flex: 1 }}/>
      <div style={{ display: 'flex', gap: 22 }}>
        {nav.map((p) => {
          const active = (p.slug || '') === (currentSlug || '');
          return (
            <Link key={p.slug || 'home'}
              to={p.slug ? `/site/${handle}/${p.slug}` : `/site/${handle}`}
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
