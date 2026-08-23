// GET /api/site/:handle/products  (public, no auth)
//
// Lists the workspace's active products for the storefront Shop section.
// Returns the same serialized shape as the owner-side /api/products list
// minus internal-only fields (cost, sku). Stays read-only - the public
// can browse but never mutate inventory.
import { sql } from '../../_lib/db.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const handle = (req.query.handle || '').toString().toLowerCase();
    if (!handle) return notFound(res);

    // Resolve workspace by website handle (the published storefront URL).
    const w = await sql`
      SELECT w2.workspace_id FROM websites w2
        JOIN workspaces ws ON ws.id = w2.workspace_id
        JOIN users u ON u.id = ws.owner_id AND u.deleted_at IS NULL
      WHERE w2.handle = ${handle}
        AND published_at IS NOT NULL
      LIMIT 1
    `;
    if (w.rows.length === 0) return notFound(res, 'No shop at that handle');
    const workspaceId = w.rows[0].workspace_id;

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
        // Surface stock state but not the exact count for non-track products.
        inStock:    p.track_stock ? Number(p.stock_qty || 0) > 0 : true,
        stockQty:   p.track_stock ? Number(p.stock_qty || 0) : null,
      })),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
