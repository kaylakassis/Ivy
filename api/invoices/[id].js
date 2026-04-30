// /api/invoices/:id
//   GET    → fetch
//   PATCH  → edit (gated to draft / overdue / sent — paid + voided are locked)
//   DELETE → remove (drafts only — others must be voided first)

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedInvoice, serializeInvoice, cleanItems } from '../_lib/finance.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const inv = await fetchOwnedInvoice({ id, workspaceId });
    if (!inv) return notFound(res, 'Invoice not found');

    if (req.method === 'GET') {
      return ok(res, { invoice: serializeInvoice(inv) });
    }

    if (req.method === 'PATCH') {
      if (inv.status === 'paid' || inv.status === 'voided') {
        return badRequest(res, `Can't edit a ${inv.status} invoice`);
      }
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('items' in body) {
        const items = cleanItems(body.items);
        if (items === null) return badRequest(res, 'Invalid items');
        push('items', JSON.stringify(items));
      }
      if ('taxRate' in body) {
        const n = Number(body.taxRate);
        if (!Number.isFinite(n) || n < 0 || n > 100) return badRequest(res, 'taxRate must be 0–100');
        push('tax_rate', n);
      }
      if ('discount' in body) {
        const n = Number(body.discount);
        if (!Number.isFinite(n) || n < 0) return badRequest(res, 'discount must be a non-negative number');
        push('discount', n);
      }
      if ('notes' in body) push('notes', body.notes == null ? null : String(body.notes).slice(0, 4000));
      if ('issueDate' in body) {
        if (body.issueDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.issueDate)) return badRequest(res, 'issueDate must be YYYY-MM-DD');
        push('issue_date', body.issueDate || null);
      }
      if ('dueDate' in body) {
        if (body.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) return badRequest(res, 'dueDate must be YYYY-MM-DD');
        push('due_date', body.dueDate || null);
      }
      if ('clientId' in body || 'clientName' in body || 'clientEmail' in body) {
        let clientId   = body.clientId ?? null;
        let clientName = body.clientName ?? null;
        let clientEmail = body.clientEmail ?? null;
        if (clientId) {
          const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
          if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
          clientName  = clientName  ?? cl.rows[0].name;
          clientEmail = clientEmail ?? cl.rows[0].email;
        }
        if ('clientId'    in body) push('client_id', clientId);
        if ('clientName'  in body) push('client_name', clientName ? String(clientName).slice(0, 200) : null);
        if ('clientEmail' in body) push('client_email', clientEmail ? String(clientEmail).toLowerCase().slice(0, 200) : null);
      }

      if (sets.length === 0) return ok(res, { invoice: serializeInvoice(inv) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE invoices SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { invoice: serializeInvoice(rows[0]) });
    }

    if (req.method === 'DELETE') {
      if (inv.status !== 'draft' && inv.status !== 'voided') {
        return badRequest(res, "Void the invoice before deleting");
      }
      await sql`DELETE FROM invoices WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
