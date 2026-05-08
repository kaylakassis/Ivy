// POST /api/recurring-invoices/run-now  body: { id }
// Forces immediate materialization of a single schedule (skipping the
// "wait until next_run_at" guard). Used by the "Run now" button on the
// Recurring tab — handy for testing, and for one-off cycles the owner
// wants to issue early.
//
// Lives as a static sibling so Vercel's router doesn't send `/run-now`
// to the [id].js dynamic handler.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeRecurring, advanceDate } from '../_lib/recurring.js';
import { serializeInvoice, nextInvoiceNumber } from '../_lib/finance.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'id is required');

    const r = await sql`SELECT * FROM recurring_invoices WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    const s = r.rows[0];
    if (!s) return badRequest(res, 'Schedule not found');
    if (s.status !== 'active') return badRequest(res, 'Schedule is not active');

    // Mint the invoice with TODAY as the issue date — distinct from
    // the cron path which uses next_run_at. We don't advance through
    // multiple cycles even if the schedule is overdue.
    const num = await nextInvoiceNumber(workspaceId);
    const number = `INV-${num}`;
    const today = new Date().toISOString().slice(0, 10);
    const dueDate = addDays(today, 14);

    const ins = await sql`
      INSERT INTO invoices (
        workspace_id, number, client_id, client_name, client_email,
        issue_date, due_date, items, tax_rate, discount, notes,
        status, activity
      ) VALUES (
        ${workspaceId}, ${number}, ${s.client_id}, ${s.client_name}, ${s.client_email},
        ${today}, ${dueDate}, ${JSON.stringify(s.items || [])}::jsonb,
        ${s.tax_rate}, ${s.discount}, ${s.notes},
        'draft',
        ${JSON.stringify([{ ts: new Date().toISOString(), kind: 'manual-run', text: `Manually run from recurring: ${s.name}` }])}::jsonb
      )
      RETURNING *
    `;
    const newInvoice = ins.rows[0];

    const oldNextStr = s.next_run_at instanceof Date ? s.next_run_at.toISOString().slice(0, 10) : s.next_run_at;
    const newNext = advanceDate(oldNextStr, s.cadence);
    const overEnd = s.end_date && (s.end_date instanceof Date ? s.end_date.toISOString().slice(0, 10) : s.end_date) < newNext;
    const upd = await sql`
      UPDATE recurring_invoices SET
        next_run_at      = ${newNext}::date,
        last_run_at      = NOW(),
        last_invoice_id  = ${newInvoice.id},
        occurrences_run  = occurrences_run + 1,
        status           = ${overEnd ? 'ended' : s.status},
        updated_at       = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;

    return ok(res, {
      schedule: serializeRecurring(upd.rows[0]),
      invoice: serializeInvoice(newInvoice),
    });
  } catch (err) {
    return serverError(res, err);
  }
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
