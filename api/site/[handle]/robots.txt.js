// GET /site/:handle/robots.txt — per-site robots file. Points crawlers
// at the sitemap and allows everything by default. Owners can extend
// this later via a future "robots.txt override" field; for v1 every
// published site gets a wide-open allow.

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  const { handle } = req.query;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'getivyos.com';
  const body = `User-agent: *
Allow: /

Sitemap: https://${host}/site/${handle}/sitemap.xml
`;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.end(body);
}
