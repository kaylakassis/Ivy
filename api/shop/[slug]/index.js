// GET /shop/:slug - server-rendered HTML for a public shop page. Routed
// here by vercel.json so crawlers and link previews get the title, meta
// tags, JSON-LD and readable markup before any JavaScript runs. The React
// page (src/features/shops/PublicShop.jsx) mounts on top of this HTML.
import { warmupDbOnce } from '../../_lib/db.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { publicShopPayload, validShopSlug } from '../../_lib/shops.js';
import { renderShopHtml } from '../../_lib/shopHtml.js';
import { renderArchivedHtml } from '../../_lib/businessAccess.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  try {
    await warmupDbOnce();
    await ensureSchemaApplied();
    const slug = String(req.query.slug || '').toLowerCase();
    if (!validShopSlug(slug)) return notFound(res, slug);
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `shophtml:ip:${ip}`, max: 120, windowSeconds: 600 }])) return;
    const payload = await publicShopPayload(slug);
    if (!payload) return notFound(res, slug);
    if (payload.archived) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return res.end(renderArchivedHtml({ businessName: payload.shop.name }));
    }
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const html = renderShopHtml({ payload, host });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=3600');
    return res.end(html);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[shop SSR] error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><html><head><title>Shop page error</title></head><body><h1>Something went wrong</h1></body></html>');
  }
}

function notFound(res, slug) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.end(`<!doctype html><html><head><title>Shop page not found</title><meta name="robots" content="noindex"/></head><body><h1>Shop page not found</h1><p>No published shop page at "${esc(slug)}".</p></body></html>`);
}
