// /api/products/:id - PATCH (edit / adjust stock), DELETE (soft via active=false).
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { serializeProduct } from '../_lib/products.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const id = (req.query.id || '').toString();
    const { rows } = await sql`SELECT * FROM products WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    const product = rows[0];
    if (!product) return notFound(res, 'Product not found');

    if (req.method === 'PATCH') {
      const b = await readBody(req);
      const name = 'name' in b ? (b.name || '').toString().trim().slice(0, 200) : product.name;
      if (!name) return badRequest(res, 'Name is required');
      const price = 'price' in b ? Math.max(0, Number(b.price) || 0) : product.price;
      const cost = 'cost' in b ? (b.cost == null || b.cost === '' ? null : Math.max(0, Number(b.cost) || 0)) : product.cost;
      const trackStock = 'trackStock' in b ? b.trackStock !== false : product.track_stock;
      const stockQty = 'stockQty' in b ? Math.max(0, Math.floor(Number(b.stockQty) || 0)) : product.stock_qty;
      const active = 'active' in b ? !!b.active : product.active;
      const sku = 'sku' in b ? ((b.sku || '').toString().slice(0, 80) || null) : product.sku;
      const category = 'category' in b ? ((b.category || '').toString().slice(0, 80) || null) : product.category;
      const upd = await sql`
        UPDATE products SET name=${name}, sku=${sku}, price=${price}, cost=${cost},
          track_stock=${trackStock}, stock_qty=${stockQty}, active=${active}, category=${category}, updated_at=NOW()
        WHERE id=${id} AND workspace_id=${workspaceId} RETURNING *
      `;
      return ok(res, { product: serializeProduct(upd.rows[0]) });
    }

    if (req.method === 'DELETE') {
      // Soft-delete: keep the row so past sales' line items still resolve.
      await sql`UPDATE products SET active = FALSE, updated_at = NOW() WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
