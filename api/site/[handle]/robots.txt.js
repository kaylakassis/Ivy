// GET /site/:handle/robots.txt - per-site robots file. Points crawlers
// at the sitemap and allows everything by default. Owners can extend
// this later via a future "robots.txt override" field; for v1 every
// published site gets a wide-open allow.
//
// An archived site (owner's subscription lapsed) disallows everything
// so crawlers drop it; the allow comes back on resubscribe.
import { workspaceAccessByHandle } from '../../_lib/businessAccess.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  const { handle } = req.query;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'joinivy.ai';
  let archivedSite = false;
  try {
    const access = await workspaceAccessByHandle(handle);
    archivedSite = !!access.workspaceId && !access.active;
  } catch { /* unknown state: keep the default allow */ }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (archivedSite) {
    res.setHeader('Cache-Control', 'no-store');
    return res.end('User-agent: *\nDisallow: /\n');
  }
  const body = `User-agent: *
Allow: /

Sitemap: https://${host}/site/${handle}/sitemap.xml
`;
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.end(body);
}
