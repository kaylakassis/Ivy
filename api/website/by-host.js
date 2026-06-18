// GET /api/website/by-host?slug=<page-slug> - no auth.
//
// Resolves the published site for the REQUEST'S HOST - a business
// owner's verified custom domain (e.g. rivers.com) - and returns the
// same shape as /api/website/public/:handle. The SPA calls this when it
// detects it's loaded on a custom domain (window.location.host is not a
// platform host), so the owner's site renders without the visitor ever
// seeing a /site/<handle> URL.
//
// Resolution (custom_domain match + verified + published + visibility)
// lives in api/_lib/publicSite.js so it stays in sync with the
// handle-based path.
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { loadPublicSite } from '../_lib/publicSite.js';
import { methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    await ensureSchemaApplied();
    // The custom domain the visitor actually typed. x-forwarded-host is
    // what Vercel sets to the public hostname; host is the fallback.
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const { slug } = req.query;
    const result = await loadPublicSite({ host, slug });
    if (result.kind !== 'ok') return notFound(res, 'Site not published');
    return ok(res, {
      site: { ...result.site, page: result.page, nav: result.nav },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
