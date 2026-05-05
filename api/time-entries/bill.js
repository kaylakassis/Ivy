// POST /api/time-entries/bill   body: { entryIds: [...], clientId? }
//
// Rolls a batch of stopped, billable, unbilled time entries into a
// fresh draft invoice for the given client. Each entry becomes one
// line item with description "<service or 'Hours'>: <description>"
// and rate = hourly_rate, qty = duration in decimal hours rounded
// to two places. Marks each entry status='billed' + invoice_id so
// it can't be billed again.
//
// Constraints:
//   • All entries must belong to the same client (or none — owner can
//     bill orphan entries against a chosen clientId).
//   • Invoice number is auto-allocated via the same sequence the
//     manual New Invoice flow uses, so numbering stays continuous.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { nextInvoiceNumber, serializeInvoice } from '../_lib/finance.js';
import { badRequest, created, methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    const ids = Array.isArray(body.entryIds) ? body.entryIds.map(String) : [];
    if (ids.length === 0) return badRequest(res, 'Pick at least one entry to bill');
    if (ids.length > 200) return badRequest(res, 'Up to 200 entries per invoice');

    const overrideClientId = body.clientId ? String(body.clientId) : null;

    // Pull entries + their joined names. Hard scope to workspace.
    const r = await sql.query(
      `SELECT t.*, c.name AS client_name, c.email AS client_email, s.name AS service_name
         FROM time_entries t
         LEFT JOIN clients c  ON c.id = t.client_id
         LEFT JOIN services s ON s.id = t.service_id
        WHERE t.workspace_id = $1 AND t.id = ANY($2::uuid[])`,
      [workspaceId, ids],
    );
    const entries = r.rows;
    if (entries.length === 0) return badRequest(res, 'No matching entries');
    if (entries.length !== ids.length) return badRequest(res, 'Some entries are missing or not yours');

    for (const e of entries) {
      if (e.status === 'billed')  return badRequest(res, 'One or more entries already billed');
      if (e.status === 'running') return badRequest(res, 'Stop running entries before billing');
      if (e.billable === false)   return badRequest(res, 'Non-billable entries can\'t be invoiced');
    }

    // Resolve client. All entries must agree, OR caller passes overrideClientId.
    const distinctClients = Array.from(new Set(entries.map((e) => e.client_id).filter(Boolean)));
    let clientId = overrideClientId;
    if (!clientId) {
      if (distinctClients.length === 0) {
        return badRequest(res, 'Entries have no client — pick one to bill against');
      }
      if (distinctClients.length > 1) {
        return badRequest(res, 'Entries are for different clients — bill them separately or pick one');
      }
      clientId = distinctClients[0];
    }
    const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
    if (cl.rows.length === 0) return badRequest(res, 'Unknown client');

    // Build line items: one per entry. Round hours to 2 decimals.
    const items = entries.map((e) => {
      const hours = Math.max(0, Math.round((Number(e.duration_seconds || 0) / 3600) * 100) / 100);
      const desc  = [
        e.service_name || 'Hours',
        e.description ? `— ${e.description}` : null,
        ` · ${(e.started_at instanceof Date ? e.started_at : new Date(e.started_at))
              .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      ].filter(Boolean).join(' ');
      return {
        id: 'li_' + e.id.slice(0, 8),
        description: desc.slice(0, 500),
        quantity: hours,
        rate: Math.round(Number(e.hourly_rate || 0) * 100) / 100,
      };
    });

    const num = await nextInvoiceNumber(workspaceId);
    const number = `INV-${num}`;
    const issueDate = new Date().toISOString().slice(0, 10);
    const due = new Date(); due.setDate(due.getDate() + 14);
    const dueDate = due.toISOString().slice(0, 10);

    const ins = await sql`
      INSERT INTO invoices (
        workspace_id, number, client_id, client_name, client_email,
        issue_date, due_date, items, status, activity
      ) VALUES (
        ${workspaceId}, ${number}, ${cl.rows[0].id}, ${cl.rows[0].name}, ${cl.rows[0].email},
        ${issueDate}, ${dueDate}, ${JSON.stringify(items)}::jsonb, 'draft',
        ${JSON.stringify([{ ts: new Date().toISOString(), kind: 'auto-created', text: `Generated from ${entries.length} time entr${entries.length === 1 ? 'y' : 'ies'}` }])}::jsonb
      )
      RETURNING *
    `;
    const invoice = ins.rows[0];

    await sql.query(
      `UPDATE time_entries SET status = 'billed', invoice_id = $1, updated_at = NOW()
        WHERE workspace_id = $2 AND id = ANY($3::uuid[])`,
      [invoice.id, workspaceId, ids],
    );

    return created(res, { invoice: serializeInvoice(invoice) });
  } catch (err) {
    return serverError(res, err);
  }
}
