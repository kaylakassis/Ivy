// /api/recurring-invoices
//   GET  → list all schedules for the current workspace
//   POST → create a new schedule (defaults: status='active',
//          autoSend=true, end_date=null = forever)
//
// Each schedule lives forever (or until end_date) and the daily cron
// (/api/cron/recurring-invoices) materializes a real invoice row at
// every interval. Editing the schedule template doesn't affect
// already-issued invoices — they capture a snapshot at issue time.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeRecurring, cleanRecurringInput } from '../_lib/recurring.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const r = await sql`
        SELECT * FROM recurring_invoices
         WHERE workspace_id = ${workspaceId}
         ORDER BY status ASC, next_run_at ASC, created_at DESC
      `;
      return ok(res, { schedules: r.rows.map(serializeRecurring) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const v = cleanRecurringInput(body, { partial: false });
      if (!v.ok) return badRequest(res, v.error);
      const s = v.sanitized;

      let clientName = null, clientEmail = null;
      if (s.clientId) {
        const cl = await sql`SELECT id, name, email FROM clients WHERE id = ${s.clientId} AND workspace_id = ${workspaceId}`;
        if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
        clientName = cl.rows[0].name;
        clientEmail = cl.rows[0].email;
      }

      const insert = await sql`
        INSERT INTO recurring_invoices (
          workspace_id, name, client_id, client_name, client_email,
          items, tax_rate, discount, notes,
          cadence, next_run_at, end_date, status, auto_send
        ) VALUES (
          ${workspaceId}, ${s.name}, ${s.clientId || null}, ${clientName}, ${clientEmail},
          ${JSON.stringify(s.items || [])}::jsonb,
          ${s.taxRate ?? 0}, ${s.discount ?? 0}, ${s.notes || null},
          ${s.cadence}, ${s.nextRunAt}::date,
          ${s.endDate ? `${s.endDate}` : null}::date,
          'active', ${s.autoSend !== false}
        )
        RETURNING *
      `;
      return created(res, { schedule: serializeRecurring(insert.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
