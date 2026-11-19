// GET /api/site/:handle/products  (public, no auth)
//
// Lists the workspace's active products for the storefront Shop section.
// Read-only. It follows the same rules as the site it belongs to
// (api/_lib/publicSite.js): a site that is private, unpublished, or whose
// owner's plan has lapsed has no public product list either. Visitors are
// told whether something is in stock, never how many are left.
import { sql } from '../../_lib/db.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { loadPublicSite } from '../../_lib/publicSite.js';
import { loadWorkspaceAccess } from '../../_lib/businessAccess.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { guardVisit, missKey } from '../../_lib/activityWatch.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    await ensureSchemaApplied();
    const handle = (req.query.handle || '').toString().toLowerCase();
    if (!handle) return notFound(res);
    if (await enforce(req, res, [{ key: `siteget:ip:${getClientIp(req)}`, max: 240, windowSeconds: 600 }])) return;

    const site = await loadPublicSite({ handle, slug: '' });
    if (await guardVisit(req, res, site.workspaceId || missKey(handle))) return;
    if (site.kind !== 'ok') return notFound(res, 'No shop at that handle');
    const workspaceId = site.workspaceId;
    const access = await loadWorkspaceAccess(workspaceId);
    if (!access.active) return ok(res, { products: [] });

    const r = await sql`
      -- NOTE: products has no description/photo_url columns (the owner
      -- editor doesn't collect them) - selecting them 500'd every
      -- storefront listing.
      SELECT id, name, price, track_stock, stock_qty
        FROM products
       WHERE workspace_id = ${workspaceId}
         AND active = TRUE
       ORDER BY name ASC
       LIMIT 200
    `;
    return ok(res, {
      products: r.rows.map((p) => ({
        id:         p.id,
        name:       p.name,
        description: null,
        price:      Number(p.price || 0),
        photoUrl:   null,
        inStock:    p.track_stock ? Number(p.stock_qty || 0) > 0 : true,
        // Kept in the shape for older app versions; the count itself is
        // the owner's business.
        stockQty:   null,
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
