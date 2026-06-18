// Shared loader for the public-facing site read.
//
// Both the JSON endpoint (api/website/public/[handle].js, used by the
// SPA fallback) and the SSR HTML endpoint (api/site/[handle].js) call
// loadPublicSite() so the resolution rules - visibility filter, page
// fallback, nav build - stay in sync.

import { sql } from './db.js';

// Result shape:
//   { kind: 'not_found' }
//   | { kind: 'ok', site, page, nav, raw }
//
// `raw` is the original row, so the SSR layer can pull seo_*/favicon_url
// without re-fetching.
export async function loadPublicSite({ handle, slug }) {
  if (!handle || typeof handle !== 'string') return { kind: 'not_found' };
  const requestedSlug = typeof slug === 'string' ? slug.toLowerCase() : '';

  const { rows } = await sql`
    SELECT handle, business_name, template,
           COALESCE(published_sections, sections) AS sections,
           COALESCE(published_pages, pages)       AS pages,
           custom_css, font_pair, published_at, visibility,
           seo_title, seo_description, seo_og_image, favicon_url,
           redirects, exit_intent_popup, sticky_cta
    FROM websites
    WHERE handle = ${handle.toLowerCase()}
      AND published_at IS NOT NULL
      AND visibility != 'only_me'
  `;
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
