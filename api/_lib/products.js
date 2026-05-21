// Retail products / inventory helpers. Stock changes are single atomic
// statements so concurrent sales can't oversell (no transaction needed
// over the HTTP driver).
import { sql } from './db.js';

export function serializeProduct(row) {
  if (!row) return null;
  return {
    id:         row.id,
    name:       row.name,
    sku:        row.sku || '',
    price:      Number(row.price || 0),
    cost:       row.cost == null ? null : Number(row.cost),
    trackStock: row.track_stock,
    stockQty:   row.stock_qty,
    active:     row.active,
    category:   row.category || '',
    createdAt:  row.created_at,
    updatedAt:  row.updated_at,
  };
}

// Atomically decrement stock. Succeeds (returns true) only if the product
// either doesn't track stock or has enough on hand — so two simultaneous
// sales of the last unit can't both win.
export async function decrementStock({ workspaceId, productId, qty }) {
  const n = Math.max(0, Math.ceil(Number(qty) || 0));
  if (!productId || n === 0) return true;
  const { rows } = await sql`
    UPDATE products
       SET stock_qty = stock_qty - ${n}, updated_at = NOW()
     WHERE id = ${productId} AND workspace_id = ${workspaceId}
       AND (track_stock = FALSE OR stock_qty >= ${n})
     RETURNING id
  `;
  return rows.length > 0;
}

// Compensating restore (used if a multi-line sale fails partway).
export async function restoreStock({ workspaceId, productId, qty }) {
  const n = Math.max(0, Math.ceil(Number(qty) || 0));
  if (!productId || n === 0) return;
  await sql`
    UPDATE products SET stock_qty = stock_qty + ${n}, updated_at = NOW()
     WHERE id = ${productId} AND workspace_id = ${workspaceId} AND track_stock = TRUE
  `.catch(() => {});
}
