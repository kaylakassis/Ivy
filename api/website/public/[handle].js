// GET /api/website/public/:handle?slug=<page-slug> — no auth.
//
// Returns only the fields needed to render a published site. Unpublished
// sites 404. When ?slug is supplied, returns just that page's sections;
// otherwise returns the home page (slug='') plus the full page index
// so the frontend can render nav.

import { sql } from '../../_lib/db.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    // Public — no requireUser path. Self-heal schema on cold-start so
    // the visibility filter below survives a fresh deploy.
    await ensureSchemaApplied();
    const { handle, slug } = req.query;
    if (!handle || typeof handle !== 'string') return notFound(res);

    const requestedSlug = typeof slug === 'string' ? slug.toLowerCase() : '';

    // 'only_me' sites are hidden from public lookup the same way an
    // unpublished site is — 404 with no detail so the slug doesn't
    // become a probe oracle. 'private' sites stay reachable by direct
    // link (same model services + packages use).
    const { rows } = await sql`
      SELECT handle, business_name, template, sections, pages,
             custom_css, font_pair, published_at, visibility
      FROM websites
      WHERE handle = ${handle.toLowerCase()}
        AND published_at IS NOT NULL
        AND visibility != 'only_me'
    `;
    if (rows.length === 0) return notFound(res, 'Site not published');

    const r = rows[0];
    const pages = Array.isArray(r.pages) ? r.pages : [];

    // Pick which page to serve. Priority:
    //   1. requestedSlug matches a page in the pages array
    //   2. requestedSlug is empty + pages has a home (slug='')
    //   3. requestedSlug is empty + pages is empty → fall back to legacy `sections`
    let pageSections;
    let pageTitle = null;
    let foundPage = null;
    if (pages.length > 0) {
      foundPage = pages.find((p) => p.slug === requestedSlug) || null;
      if (!foundPage && requestedSlug !== '') {
        return notFound(res, 'Page not found');
      }
      if (!foundPage) foundPage = pages.find((p) => p.slug === '') || pages[0];
      pageSections = foundPage.sections || [];
      pageTitle = foundPage.title || null;
    } else {
      // Legacy single-page site. Only the home URL renders; other
      // sub-paths 404 cleanly.
      if (requestedSlug !== '') return notFound(res, 'Page not found');
      pageSections = r.sections || [];
    }

    // Page index for nav rendering. Filter to in-nav entries; include
    // the home page even when in_nav is false so the logo can link to it.
    const nav = pages
      .filter((p) => p.inNav !== false)
      .map((p) => ({ slug: p.slug, title: p.title }));

    return ok(res, {
      site: {
        handle:       r.handle,
        businessName: r.business_name,
        template:     r.template,
        customCss:    r.custom_css || '',
        fontPair:     r.font_pair || null,
        publishedAt:  r.published_at,
        // Currently-rendered page.
        page: {
          slug: foundPage ? foundPage.slug : '',
          title: pageTitle,
          sections: pageSections,
        },
        // All pages (for nav). Empty when site is single-page.
        nav,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
