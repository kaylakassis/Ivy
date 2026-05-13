// GET /site/:handle — server-rendered HTML for the published site's
// home page. Routed here by vercel.json so crawlers + social cards see
// the title/meta tags + body content before any JS executes.
//
// The React SPA (built into dist/) mounts on top of this HTML once the
// browser parses our injected <script>. Anything in <div id="root">
// gets replaced by React on render — that's fine, the static markup is
// only there for crawlers and for the millisecond before JS runs.

import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { loadPublicSite } from '../_lib/publicSite.js';
import { renderSiteHtml } from '../_lib/siteHtml.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  try {
    await ensureSchemaApplied();
    const { handle } = req.query;
    const result = await loadPublicSite({ handle, slug: '' });
    if (result.kind !== 'ok') return notFound(res, handle);
    // Honor owner-configured 301 redirects before rendering.
    const hit = matchRedirect(result.site.redirects, '');
    if (hit) return redirect(res, hit, handle);

    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const html = renderSiteHtml({
      site: result.site,
      page: result.page,
      nav:  result.nav,
      handle: result.site.handle,
      currentSlug: '',
      host,
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Edge cache for 5 min, serve stale up to a day while revalidating.
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
    return res.end(html);
  } catch (err) {
    return serverError(res, err);
  }
}

function notFound(res, handle) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(`<!doctype html><html><head><title>Site not found</title><meta name="robots" content="noindex"/></head><body><h1>Site not found</h1><p>No published site for "${escapeHtml(handle || '')}".</p></body></html>`);
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

// Owner-configured redirects: array of { from, to }. Match the
// requested slug against from; redirect to `to` if found. Slug-only
// (no querystring matching) for v1.
function matchRedirect(rules, currentSlug) {
  if (!Array.isArray(rules)) return null;
  const slug = String(currentSlug || '').toLowerCase();
  for (const r of rules) {
    if (!r || !r.from || !r.to) continue;
    if (String(r.from).toLowerCase() === slug) return r.to;
  }
  return null;
}

function redirect(res, target, handle) {
  // Targets starting with / route within the site; others are external.
  const url = String(target).startsWith('/')
    ? `/site/${handle}${target}`
    : String(target);
  res.statusCode = 301;
  res.setHeader('Location', url);
  return res.end();
}
