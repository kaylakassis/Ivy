// /api/expenses/:id
//   PATCH  → edit fields
//   DELETE → remove
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  serializeExpense, SCHEDULE_C_KEYS, VALID_PAYMENT_METHODS,
} from '../_lib/expenses.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

function isoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const found = await sql`
      SELECT * FROM expenses WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
    if (found.rows.length === 0) return notFound(res, 'Expense not found');

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('amount' in body) {
        const n = Number(body.amount);
        if (!Number.isFinite(n) || n <= 0 || n > 1e7) return badRequest(res, 'amount must be positive');
        push('amount', n);
      }
      if ('date' in body) {
        const d = isoDate(body.date);
        if (!d) return badRequest(res, 'date must be YYYY-MM-DD');
        push('date', d);
      }
      if ('category' in body) {
        if (!SCHEDULE_C_KEYS.has(body.category)) return badRequest(res, 'Invalid category');
        push('category', body.category);
      }
      if ('vendor' in body) push('vendor', body.vendor ? String(body.vendor).slice(0, 200) : null);
      if ('notes'  in body) push('notes',  body.notes  ? String(body.notes).slice(0, 2000) : null);
      if ('receiptUrl' in body) push('receipt_url', body.receiptUrl ? String(body.receiptUrl).slice(0, 500) : null);
      if ('paymentMethod' in body) {
        if (body.paymentMethod && !VALID_PAYMENT_METHODS.has(body.paymentMethod)) return badRequest(res, 'Invalid paymentMethod');
        push('payment_method', body.paymentMethod || null);
      }
      if ('isDeductible' in body) push('is_deductible', !!body.isDeductible);

      if (sets.length === 0) return ok(res, { expense: serializeExpense(found.rows[0]) });
      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE expenses SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { expense: serializeExpense(rows[0]) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM expenses WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
