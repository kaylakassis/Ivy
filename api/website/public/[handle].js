// GET /api/website/public/:handle — no auth.
// Returns only fields needed to render a published site. Unpublished sites 404.

import { sql } from '../../_lib/db.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    // Public — no requireUser path. Self-heal schema on cold-start so
    // the visibility filter below survives a fresh deploy.
    await ensureSchemaApplied();
    const { handle } = req.query;
    if (!handle || typeof handle !== 'string') return notFound(res);

    // 'only_me' sites are hidden from public lookup the same way an
    // unpublished site is — 404 with no detail so the slug doesn't
    // become a probe oracle. 'private' sites stay reachable by direct
    // link (same model services + packages use).
    const { rows } = await sql`
      SELECT handle, business_name, template, sections, published_at, visibility
      FROM websites
      WHERE handle = ${handle.toLowerCase()}
        AND published_at IS NOT NULL
        AND visibility != 'only_me'
    `;
    if (rows.length === 0) return notFound(res, 'Site not published');

    const r = rows[0];
    return ok(res, {
      site: {
        handle: r.handle,
        businessName: r.business_name,
        template: r.template,
        sections: r.sections || [],
        publishedAt: r.published_at,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
