// GET /shops-sitemap.xml → every published shop page (owner on a plan).
// Listed in public/robots.txt so search engines find shop pages.
import { warmupDbOnce } from '../_lib/db.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { publishedShopSlugs } from '../_lib/shops.js';

const ORIGIN = 'https://www.joinivy.ai';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  try {
    await warmupDbOnce();
    await ensureSchemaApplied();
    const shops = await publishedShopSlugs();
    const urls = shops.map((s) => `  <url><loc>${ORIGIN}/shop/${encodeURIComponent(s.slug)}</loc>${s.updatedAt ? `<lastmod>${new Date(s.updatedAt).toISOString().slice(0, 10)}</lastmod>` : ''}<changefreq>daily</changefreq></url>`).join('\n');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[shops sitemap] error:', err);
    res.statusCode = 500;
    return res.end('');
  }
}
