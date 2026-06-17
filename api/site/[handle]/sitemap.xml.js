// GET /site/:handle/sitemap.xml — XML sitemap listing every page of a
// published site. Search engines fetch this to discover the page graph
// and re-crawl efficiently after edits.

import { sql } from '../../_lib/db.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  try {
    await ensureSchemaApplied();
    const { handle } = req.query;
    if (!handle || typeof handle !== 'string') {
      res.statusCode = 404;
      return res.end('Not Found');
    }
    const { rows } = await sql`
      SELECT handle, pages, updated_at, published_at
      FROM websites
      WHERE handle = ${handle.toLowerCase()}
        AND published_at IS NOT NULL
        AND visibility != 'only_me'
    `;
    if (rows.length === 0) {
      res.statusCode = 404;
      return res.end('Not Found');
    }
    const r = rows[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'getivyos.com';
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
