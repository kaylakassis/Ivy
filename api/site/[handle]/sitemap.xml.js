// GET /site/:handle/sitemap.xml - XML sitemap listing every page of a
// published site. Search engines fetch this to discover the page graph
// and re-crawl efficiently after edits.

import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { loadCrawlableSite } from '../../_lib/publicSite.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  try {
    await ensureSchemaApplied();
    const { handle } = req.query;
    // Same rules as the pages (api/_lib/publicSite.js): an unpublished or
    // private site, or one whose owner deleted their account, 404s here
    // exactly as its pages do. (The deleted-account case used to keep
    // listing every page URL forever.)
    const site = await loadCrawlableSite(typeof handle === 'string' ? handle : '');
    if (site.kind === 'not_found') {
      res.statusCode = 404;
      res.setHeader('Cache-Control', 'no-store');
      return res.end('Not Found');
    }
    // Archived site: an empty (but valid) sitemap, so crawlers see
    // nothing to index. robots.txt disallows everything alongside.
    if (site.kind === 'archived') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>');
    }
    const r = site.row;
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'joinivy.ai';
    const base = `https://${host}/site/${r.handle}`;
    const pages = Array.isArray(r.pages) && r.pages.length > 0
      ? r.pages
      : [{ slug: '', title: 'Home' }];

    const lastmod = (r.updated_at || r.published_at || new Date()).toISOString();
    const urls = pages.map((p) => {
      const loc = p.slug ? `${base}/${p.slug}` : base;
      return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
  </url>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
    return res.end(xml);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sitemap] error:', err);
    res.statusCode = 500;
    return res.end('error');
  }
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' }[c]));
}
