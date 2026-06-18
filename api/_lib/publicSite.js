// Shared loader for the public-facing site read.
//
// Both the JSON endpoint (api/website/public/[handle].js, used by the
// SPA fallback) and the SSR HTML endpoint (api/site/[handle]/index.js)
// call loadPublicSite() so the resolution rules - visibility filter,
// page fallback, nav build - stay in sync.
//
// Two ways to identify the site:
//   • handle  - the platform URL getivyos.com/site/:handle
//   • host    - the owner's VERIFIED custom domain (e.g. rivers.com).
//               Used when a request arrives at the custom domain itself.

import { sql } from './db.js';

// Normalize a hostname for comparison: lowercase, strip trailing dot.
// Returns the bare + www variants so we match a stored custom_domain
// regardless of which form the owner saved and which the visitor used.
function hostVariants(host) {
  const h = String(host || '').toLowerCase().trim().replace(/\.+$/, '');
  if (!h) return [];
  const bare = h.replace(/^www\./, '');
  return Array.from(new Set([h, bare, `www.${bare}`]));
}

// Result shape:
//   { kind: 'not_found' }
//   | { kind: 'ok', site, page, nav, raw }
//
// `raw` is the original row, so the SSR layer can pull seo_*/favicon_url
// without re-fetching.
export async function loadPublicSite({ handle, slug, host }) {
  const requestedSlug = typeof slug === 'string' ? slug.toLowerCase() : '';

  let rows;
  if (handle && typeof handle === 'string') {
    ({ rows } = await sql`
      SELECT handle, business_name, template,
             COALESCE(published_sections, sections) AS sections,
             COALESCE(published_pages, pages)       AS pages,
             custom_css, font_pair, published_at, visibility, custom_domain,
             seo_title, seo_description, seo_og_image, favicon_url,
             redirects, exit_intent_popup, sticky_cta
      FROM websites
      WHERE handle = ${handle.toLowerCase()}
        AND published_at IS NOT NULL
        AND visibility != 'only_me'
    `);
  } else if (host && typeof host === 'string') {
    const variants = hostVariants(host);
    if (variants.length === 0) return { kind: 'not_found' };
    ({ rows } = await sql`
      SELECT handle, business_name, template,
             COALESCE(published_sections, sections) AS sections,
             COALESCE(published_pages, pages)       AS pages,
             custom_css, font_pair, published_at, visibility, custom_domain,
             seo_title, seo_description, seo_og_image, favicon_url,
             redirects, exit_intent_popup, sticky_cta
      FROM websites
      WHERE lower(custom_domain) = ANY(${variants})
        AND domain_status = 'verified'
        AND published_at IS NOT NULL
        AND visibility != 'only_me'
    `);
  } else {
    return { kind: 'not_found' };
  }
  if (rows.length === 0) return { kind: 'not_found' };

  const r = rows[0];
  const pages = Array.isArray(r.pages) ? r.pages : [];

  let pageSections;
  let pageTitle = null;
  let foundPage = null;
  let pageMeta = {};
  if (pages.length > 0) {
    foundPage = pages.find((p) => p.slug === requestedSlug) || null;
    if (!foundPage && requestedSlug !== '') return { kind: 'not_found' };
    if (!foundPage) foundPage = pages.find((p) => p.slug === '') || pages[0];
    pageSections = foundPage.sections || [];
    pageTitle = foundPage.title || null;
    pageMeta = {
      metaTitle:       foundPage.metaTitle || null,
      metaDescription: foundPage.metaDescription || null,
      ogImage:         foundPage.ogImage || null,
    };
  } else {
    if (requestedSlug !== '') return { kind: 'not_found' };
    pageSections = r.sections || [];
  }

  const nav = pages
    .filter((p) => p.inNav !== false)
    .map((p) => ({ slug: p.slug, title: p.title }));

  return {
    kind: 'ok',
    raw: r,
    site: {
      handle:       r.handle,
      businessName: r.business_name,
      template:     r.template,
      customCss:    r.custom_css || '',
      fontPair:     r.font_pair || null,
      publishedAt:  r.published_at,
      seoTitle:        r.seo_title || null,
      seoDescription:  r.seo_description || null,
      seoOgImage:      r.seo_og_image || null,
      faviconUrl:      r.favicon_url || null,
      redirects:       Array.isArray(r.redirects) ? r.redirects : [],
      exitIntentPopup: r.exit_intent_popup || null,
      stickyCta:       r.sticky_cta || null,
    },
    page: {
      slug: foundPage ? foundPage.slug : '',
      title: pageTitle,
      sections: pageSections,
      ...pageMeta,
    },
    nav,
  };
}
