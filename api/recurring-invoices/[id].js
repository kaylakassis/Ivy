// /api/recurring-invoices/:id
//   GET    → fetch a single schedule
//   PATCH  → update template fields (items / cadence / status / etc.).
//            Editing here doesn't touch invoices already issued from
//            this schedule — those captured a snapshot at issue time.
//   DELETE → remove the schedule entirely. Already-issued invoices
//            stay; they referenced the schedule via last_invoice_id
//            on the schedule, not the other way around.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeRecurring, cleanRecurringInput } from '../_lib/recurring.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

async function fetchOwned(id, workspaceId) {
  if (!id) return null;
  const r = await sql`SELECT * FROM recurring_invoices WHERE id = ${id} AND workspace_id = ${workspaceId}`;
  return r.rows[0] || null;
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const s = await fetchOwned(id, workspaceId);
    if (!s) return notFound(res, 'Schedule not found');

    if (req.method === 'GET') {
      return ok(res, { schedule: serializeRecurring(s) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const v = cleanRecurringInput(body, { partial: true });
      if (!v.ok) return badRequest(res, v.error);
      const sanitized = v.sanitized;

      // Re-resolve client name/email if clientId changed.
      let clientName = null, clientEmail = null;
      let setClient = false;
      if ('clientId' in sanitized) {
        setClient = true;
        if (sanitized.clientId) {
          const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${sanitized.clientId} AND workspace_id = ${workspaceId}`;
          if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
          clientName = cl.rows[0].name;
          clientEmail = cl.rows[0].email;
        }
      }

      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('name' in sanitized)      push('name',         sanitized.name);
      if (setClient)                push('client_id',    sanitized.clientId || null);
      if (setClient)                push('client_name',  clientName);
      if (setClient)                push('client_email', clientEmail);
      if ('items' in sanitized)     push('items',        JSON.stringify(sanitized.items));
      if ('taxRate' in sanitized)   push('tax_rate',     sanitized.taxRate);
      if ('discount' in sanitized)  push('discount',     sanitized.discount);
      if ('notes' in sanitized)     push('notes',        sanitized.notes);
      if ('cadence' in sanitized)   push('cadence',      sanitized.cadence);
      if ('nextRunAt' in sanitized) push('next_run_at',  sanitized.nextRunAt);
      if ('endDate' in sanitized)   push('end_date',     sanitized.endDate);
      if ('status' in sanitized)    push('status',       sanitized.status);
      if ('autoSend' in sanitized)  push('auto_send',    sanitized.autoSend);

      if (sets.length === 0) return ok(res, { schedule: serializeRecurring(s) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE recurring_invoices SET ${sets.join(', ')}
         WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
         RETURNING *
      `;
      // sanitized items needs to be a JSONB cast. The push above
      // emitted `items = $N` which won't auto-cast — we wrap that
      // particular slot when items is set.
      const finalText = queryText.replace(/items = \$(\d+)/, 'items = $$$1::jsonb');
      const { rows } = await sql.query(finalText, values);
      return ok(res, { schedule: serializeRecurring(rows[0]) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM recurring_invoices WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
