// /api/products - GET list, POST create.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { serializeProduct } from '../_lib/products.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (req.method === 'GET') {
      const includeInactive = req.query.all === '1';
      const { rows } = includeInactive
        ? await sql`SELECT * FROM products WHERE workspace_id = ${workspaceId} ORDER BY name ASC`
        : await sql`SELECT * FROM products WHERE workspace_id = ${workspaceId} AND active = TRUE ORDER BY name ASC`;
      return ok(res, { products: rows.map(serializeProduct) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').toString().trim().slice(0, 200);
      if (!name) return badRequest(res, 'Name is required');
      const price = Math.max(0, Number(body.price) || 0);
      const cost = body.cost == null || body.cost === '' ? null : Math.max(0, Number(body.cost) || 0);
      const trackStock = body.trackStock !== false;
      const stockQty = Math.max(0, Math.floor(Number(body.stockQty) || 0));
      const ins = await sql`
        INSERT INTO products (workspace_id, name, sku, price, cost, track_stock, stock_qty, category)
        VALUES (${workspaceId}, ${name}, ${(body.sku || '').toString().slice(0, 80) || null},
                ${price}, ${cost}, ${trackStock}, ${stockQty},
                ${(body.category || '').toString().slice(0, 80) || null})
        RETURNING *
      `;
      return created(res, { product: serializeProduct(ins.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
