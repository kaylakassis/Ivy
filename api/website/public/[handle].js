// GET /api/website/public/:handle?slug=<page-slug> — no auth.
//
// Returns only the fields needed to render a published site. Unpublished
// sites 404. When ?slug is supplied, returns just that page's sections;
// otherwise returns the home page (slug='') plus the full page index
// so the frontend can render nav.
//
// Resolution rules live in api/_lib/publicSite.js so the SSR HTML route
// uses the same logic — keeps "what's visible" decisions in one place.

import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { loadPublicSite } from '../../_lib/publicSite.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    // Public — no requireUser path. Self-heal schema on cold-start so
    // the visibility filter below survives a fresh deploy.
    await ensureSchemaApplied();
    const { handle, slug } = req.query;
    const result = await loadPublicSite({ handle, slug });
    if (result.kind !== 'ok') return notFound(res, 'Site not published');

    return ok(res, {
      site: {
        ...result.site,
        page: result.page,
        nav: result.nav,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
