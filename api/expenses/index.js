// /api/expenses
//   GET  → list (optional ?from=YYYY-MM-DD&to=YYYY-MM-DD&category=key)
//   POST → create. body: { amount, date, category, vendor?, notes?,
//                          receiptUrl?, paymentMethod?, isDeductible? }
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  serializeExpense, SCHEDULE_C_KEYS, VALID_PAYMENT_METHODS,
} from '../_lib/expenses.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

function isoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const from = isoDate(req.query.from);
      const to   = isoDate(req.query.to);
      const cat  = (req.query.category || '').toString();
      const conditions = ['workspace_id = $1'];
      const values = [workspaceId];
      if (from) { values.push(from); conditions.push(`date >= $${values.length}`); }
      if (to)   { values.push(to);   conditions.push(`date <= $${values.length}`); }
      if (cat && SCHEDULE_C_KEYS.has(cat)) {
        values.push(cat); conditions.push(`category = $${values.length}`);
      }
      const queryText = `
        SELECT * FROM expenses
        WHERE ${conditions.join(' AND ')}
        ORDER BY date DESC, created_at DESC
        LIMIT 1000
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { expenses: rows.map(serializeExpense) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const amount = Number(body.amount);
      const date   = isoDate(body.date);
      const category = (body.category || '').toString();
      const vendor   = body.vendor   ? String(body.vendor).slice(0, 200)   : null;
      const notes    = body.notes    ? String(body.notes).slice(0, 2000)   : null;
      const receiptUrl    = body.receiptUrl    ? String(body.receiptUrl).slice(0, 500) : null;
      const paymentMethod = body.paymentMethod || null;
      const isDeductible  = body.isDeductible == null ? true : !!body.isDeductible;

      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) {
        return badRequest(res, 'amount must be a positive number');
      }
      if (!date) return badRequest(res, 'date must be YYYY-MM-DD');
      if (!SCHEDULE_C_KEYS.has(category)) {
        return badRequest(res, 'Invalid category');
      }
      if (paymentMethod && !VALID_PAYMENT_METHODS.has(paymentMethod)) {
        return badRequest(res, 'Invalid paymentMethod');
      }

      const { rows } = await sql`
        INSERT INTO expenses (
          workspace_id, amount, date, category, vendor, notes,
          receipt_url, payment_method, is_deductible
        ) VALUES (
          ${workspaceId}, ${amount}, ${date}, ${category}, ${vendor}, ${notes},
          ${receiptUrl}, ${paymentMethod}, ${isDeductible}
        )
        RETURNING *
      `;
      return created(res, { expense: serializeExpense(rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
