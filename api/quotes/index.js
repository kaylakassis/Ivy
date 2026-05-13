// /api/quotes
//   GET  → list quotes for the workspace (filterable by status)
//   POST → create a new draft quote (auto-numbered)
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeQuote, cleanItems, nextQuoteNumber, VALID_STATUS } from '../_lib/quotes.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      try {
        const status = req.query.status;
        let rows;
        if (status && VALID_STATUS.has(status)) {
          const r = await sql`
            SELECT * FROM quotes
            WHERE workspace_id = ${workspaceId} AND status = ${status}
            ORDER BY issue_date DESC, created_at DESC
          `;
          rows = r.rows;
        } else {
          const r = await sql`
            SELECT * FROM quotes
            WHERE workspace_id = ${workspaceId}
            ORDER BY issue_date DESC, created_at DESC
          `;
          rows = r.rows;
        }
        return ok(res, { quotes: rows.map(serializeQuote) });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[quotes GET] failed (returning empty):', e.message);
        return ok(res, { quotes: [] });
      }
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const items = cleanItems(body.items ?? []);
      if (items === null) return badRequest(res, 'Invalid items');

      const taxRate  = Number(body.taxRate ?? 0);
      const discount = Number(body.discount ?? 0);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100)
        return badRequest(res, 'taxRate must be 0–100');
      if (!Number.isFinite(discount) || discount < 0)
        return badRequest(res, 'discount must be a non-negative number');

      const issueDate = body.issueDate || new Date().toISOString().slice(0, 10);
      const expiryDate = body.expiryDate || null;
      if (issueDate && !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) return badRequest(res, 'issueDate must be YYYY-MM-DD');
      if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) return badRequest(res, 'expiryDate must be YYYY-MM-DD');

      const notes = body.notes ? String(body.notes).slice(0, 4000) : null;

      let clientId   = body.clientId ? String(body.clientId) : null;
      let clientName  = body.clientName  ? String(body.clientName).slice(0, 200)  : null;
      let clientEmail = body.clientEmail ? String(body.clientEmail).slice(0, 200).toLowerCase() : null;

      if (clientId) {
        const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
        if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
        clientName = clientName || cl.rows[0].name;
        clientEmail = clientEmail || cl.rows[0].email;
      }

      const num = await nextQuoteNumber(workspaceId);
      const number = `QUO-${num}`;

      const insert = await sql`
        INSERT INTO quotes (
          workspace_id, number, client_id, client_name, client_email,
          issue_date, expiry_date, items, tax_rate, discount, notes, status
        ) VALUES (
          ${workspaceId}, ${number}, ${clientId}, ${clientName}, ${clientEmail},
          ${issueDate}, ${expiryDate}, ${JSON.stringify(items)}::jsonb, ${taxRate}, ${discount}, ${notes}, 'draft'
        )
        RETURNING *
      `;
      return created(res, { quote: serializeQuote(insert.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
