// GET /api/website/public/:handle — no auth.
// Returns only fields needed to render a published site. Unpublished sites 404.

import { sql } from '../../_lib/db.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const { handle } = req.query;
    if (!handle || typeof handle !== 'string') return notFound(res);

    const { rows } = await sql`
      SELECT handle, business_name, template, sections, published_at
      FROM websites
      WHERE handle = ${handle.toLowerCase()} AND published_at IS NOT NULL
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
