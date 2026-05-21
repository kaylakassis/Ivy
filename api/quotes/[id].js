// /api/quotes/:id
//   GET    → fetch one quote
//   PATCH  → edit draft / sent (items, dates, notes); locks once
//            accepted because the resulting invoice is the canonical
//            record from that point forward
//   DELETE → delete (only allowed on drafts)
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeQuote, cleanQuoteItems, fetchOwnedQuote } from '../_lib/quotes.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;
    const { id } = req.query;

    const quote = await fetchOwnedQuote({ id, workspaceId });
    if (!quote) return notFound(res, 'Quote not found');

    if (req.method === 'GET') return ok(res, { quote: serializeQuote(quote) });

    if (req.method === 'PATCH') {
      if (quote.status === 'accepted') return badRequest(res, "Can't edit an accepted quote");
      if (quote.status === 'declined') return badRequest(res, "Can't edit a declined quote");
      if (quote.status === 'expired')  return badRequest(res, "Can't edit an expired quote");

      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('items' in body) {
        const items = cleanQuoteItems(body.items);
        if (items === null) return badRequest(res, 'Invalid items');
        push('items', JSON.stringify(items));
      }
      if ('taxRate' in body) {
        const v = Number(body.taxRate);
        if (!Number.isFinite(v) || v < 0 || v > 100) return badRequest(res, 'taxRate must be 0–100');
        push('tax_rate', v);
      }
      if ('discount' in body) {
        const v = Number(body.discount);
        if (!Number.isFinite(v) || v < 0) return badRequest(res, 'discount must be non-negative');
        push('discount', v);
      }
      if ('issueDate' in body) {
        const v = body.issueDate || null;
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return badRequest(res, 'issueDate format');
        push('issue_date', v);
      }
      if ('expiryDate' in body) {
        const v = body.expiryDate || null;
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return badRequest(res, 'expiryDate format');
        push('expiry_date', v);
      }
      if ('notes' in body) push('notes', body.notes ? String(body.notes).slice(0, 4000) : null);
      if ('clientId' in body) {
        const cid = body.clientId ? String(body.clientId) : null;
        if (cid) {
          const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${cid} AND workspace_id = ${workspaceId}`;
          if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
          push('client_id', cl.rows[0].id);
          push('client_name', cl.rows[0].name);
          push('client_email', cl.rows[0].email);
        } else {
          push('client_id', null);
        }
      }

      if (sets.length === 0) return ok(res, { quote: serializeQuote(quote) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      let queryText = `
        UPDATE quotes SET ${sets.join(', ')}
         WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
         RETURNING *
      `;
      queryText = queryText.replace(/items = \$(\d+)/, 'items = $$$1::jsonb');
      const { rows } = await sql.query(queryText, values);
      return ok(res, { quote: serializeQuote(rows[0]) });
    }

    if (req.method === 'DELETE') {
      if (quote.status !== 'draft') return badRequest(res, 'Only draft quotes can be deleted');
      await sql`DELETE FROM quotes WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
