// GET /site/:handle/:slug — server-rendered HTML for a sub-page of a
// multi-page published site. Same logic as the home-page route, just
// with a non-empty slug. See api/site/[handle].js for the why.

import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { loadPublicSite } from '../../_lib/publicSite.js';
import { renderSiteHtml } from '../../_lib/siteHtml.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  try {
    await ensureSchemaApplied();
    const { handle, slug } = req.query;
    // Reserved sub-paths (sitemap.xml, robots.txt) have their own
    // routes — Vercel will match the more specific file first, but
    // guard anyway in case the rewrite order changes.
    if (slug === 'sitemap.xml' || slug === 'robots.txt') {
      res.statusCode = 404;
      return res.end('Not Found');
    }

    const result = await loadPublicSite({ handle, slug });
    if (result.kind !== 'ok') return notFound(res, handle, slug);

    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const html = renderSiteHtml({
      site: result.site,
      page: result.page,
      nav:  result.nav,
      handle: result.site.handle,
      currentSlug: slug || '',
      host,
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
    return res.end(html);
  } catch (err) {
    return serverError(res, err);
  }
}

function notFound(res, handle, slug) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(`<!doctype html><html><head><title>Page not found</title><meta name="robots" content="noindex"/></head><body><h1>Page not found</h1><p>No page "${escapeHtml(slug || '')}" on site "${escapeHtml(handle || '')}".</p></body></html>`);
}

function serverError(res, err) {
  // eslint-disable-next-line no-console
  console.error('[site SSR] error:', err);
  res.statusCode = 500;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end('<!doctype html><html><head><title>Site error</title></head><body><h1>Something went wrong</h1></body></html>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
