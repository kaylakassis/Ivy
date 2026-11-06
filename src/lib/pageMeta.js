// Per-page <head> for the public marketing + legal pages: title,
// description, canonical, Open Graph, Twitter card and JSON-LD.
//
// Every public page sets its head through usePageMeta so the tags are
// produced in exactly one place. scripts/prerender.mjs loads each page in
// a headless browser at build time and saves the resulting document, head
// included, as static HTML for crawlers that do not run JavaScript. When
// React then boots on one of those saved pages it finds the tags already
// present and only updates them in place, so nothing is duplicated.
import { useEffect } from 'react';

// Canonical public host. The apex joinivy.ai answers every request with a
// 308 to www (docs/REBRAND_CHECKLIST.md), so www is the host crawlers,
// the sitemap and llms.txt must all agree on.
export const SITE_ORIGIN = 'https://www.joinivy.ai';

// One branded social image for the whole site (public/og-image.png,
// 1200x630, logo on the brand ground).
export const OG_IMAGE = `${SITE_ORIGIN}/og-image.png`;
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

export function siteUrl(path = '/') {
  return SITE_ORIGIN + (path.startsWith('/') ? path : '/' + path);
}

// Schema.org BreadcrumbList for a sub-page: Home > Section > Page.
export function breadcrumbs(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name,
      item: siteUrl(path),
    })),
  };
}

// `meta` may be null for a page that is about to redirect (unknown slug),
// so callers can keep the hook unconditional.
export function usePageMeta(meta) {
  const { title, description, canonical, ogType = 'website', jsonLd } = meta || {};
  useEffect(() => {
    if (!title) return undefined;
    document.title = title;
    const head = document.head;
    const ensure = (sel, make) => {
      let el = head.querySelector(sel);
      if (!el) { el = make(); head.appendChild(el); }
      return el;
    };
    const meta = (attr, name, content) => {
      const el = ensure(`meta[${attr}="${name}"]`, () => {
        const m = document.createElement('meta'); m.setAttribute(attr, name); return m;
      });
      el.setAttribute('content', content);
      el.dataset.siteMeta = '1';
    };
    meta('name', 'description', description);
    meta('property', 'og:type', ogType);
    meta('property', 'og:site_name', 'Ivy');
    meta('property', 'og:title', title);
    meta('property', 'og:description', description);
    if (canonical) meta('property', 'og:url', canonical);
    meta('property', 'og:image', OG_IMAGE);
    meta('property', 'og:image:width', String(OG_IMAGE_WIDTH));
    meta('property', 'og:image:height', String(OG_IMAGE_HEIGHT));
    meta('property', 'og:image:alt', 'Ivy');
    meta('name', 'twitter:card', 'summary_large_image');
    meta('name', 'twitter:title', title);
    meta('name', 'twitter:description', description);
    meta('name', 'twitter:image', OG_IMAGE);
    if (canonical) {
      const link = ensure('link[rel="canonical"]', () => {
        const l = document.createElement('link'); l.setAttribute('rel', 'canonical'); return l;
      });
      link.setAttribute('href', canonical);
    }
    // JSON-LD: replace whatever an earlier page (or the pre-rendered
    // document) left behind, so there is never more than one copy.
    head.querySelectorAll('script[type="application/ld+json"][data-site-meta]').forEach((s) => s.remove());
    let ld = null;
    if (jsonLd) {
      ld = document.createElement('script');
      ld.type = 'application/ld+json';
      ld.dataset.siteMeta = '1';
      ld.textContent = JSON.stringify(jsonLd);
      head.appendChild(ld);
    }
    return () => { if (ld) ld.remove(); };
  }, [title, description, canonical, ogType, jsonLd]);
}
