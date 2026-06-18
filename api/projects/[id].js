// /api/projects/:id
//   GET    → single project + linked artifacts (bookings, invoices, quotes, documents)
//   PATCH  → update mutable fields
//   DELETE → remove (artifacts keep existing, project_id set to NULL by FK rule)
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedProject, serializeProject, VALID_STATUS } from '../_lib/projects.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

// Invoices + quotes don't store `total` as a column - it's computed
// from items + tax_rate + discount on read. Mirrors the math in
// api/_lib/finance.js so the drawer values match what the editor and
// PDF show.
function invoiceTotal(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  const subtotal = items.reduce(
    (s, it) => s + Number(it.quantity || 0) * Number(it.rate || 0), 0,
  );
  const taxable = Math.max(0, subtotal - Number(row.discount || 0));
  const tax = taxable * (Number(row.tax_rate || 0) / 100);
  return Math.round((taxable + tax) * 100) / 100;
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    const existing = await fetchOwnedProject({ id, workspaceId });
    if (!existing) return notFound(res, 'Project not found');

    if (req.method === 'GET') {
      // Pull every linked artifact in parallel. Each is a thin row -
      // enough to render in the project drawer's tabs without follow-up.
      const [bookings, invoices, quotes, documents] = await Promise.all([
        sql`SELECT id, date, start_min, end_min, client_name, notes
              FROM bookings WHERE project_id = ${id} AND workspace_id = ${workspaceId}
              ORDER BY date DESC, start_min DESC LIMIT 100`,
        sql`SELECT id, number, status, client_name, items, tax_rate, discount
              FROM invoices WHERE project_id = ${id} AND workspace_id = ${workspaceId}
              ORDER BY created_at DESC LIMIT 100`,
        sql`SELECT id, number, status, client_name, items, tax_rate, discount
              FROM quotes WHERE project_id = ${id} AND workspace_id = ${workspaceId}
              ORDER BY created_at DESC LIMIT 100`,
        sql`SELECT id, name, status
              FROM documents WHERE project_id = ${id} AND workspace_id = ${workspaceId}
              ORDER BY updated_at DESC LIMIT 100`,
      ]).catch((e) => { throw e; });

      return ok(res, {
        project: serializeProject(existing, {
          bookings:  bookings.rows.length,
          invoices:  invoices.rows.length,
          quotes:    quotes.rows.length,
          documents: documents.rows.length,
        }),
        linked: {
          bookings:  bookings.rows.map((b) => ({
            id: b.id,
            date: b.date instanceof Date ? b.date.toISOString().slice(0, 10) : b.date,
            startMin: b.start_min,
            endMin:   b.end_min,
            clientName: b.client_name,
            notes:     b.notes || null,
          })),
          invoices: invoices.rows.map((i) => ({
            id: i.id, number: i.number, status: i.status,
            clientName: i.client_name, total: invoiceTotal(i),
          })),
          quotes: quotes.rows.map((q) => ({
            id: q.id, number: q.number, status: q.status,
            clientName: q.client_name, total: invoiceTotal(q),
          })),
          documents: documents.rows.map((d) => ({
            id: d.id, name: d.name, status: d.status,
          })),
        },
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('name' in body) {
        const v = (body.name || '').toString().trim();
        if (!v) return badRequest(res, 'Name cannot be empty');
        if (v.length > 200) return badRequest(res, 'Name too long');
        push('name', v);
      }
      if ('description' in body) push('description', body.description == null ? null : String(body.description).slice(0, 4000));
      if ('status' in body) {
        // Lowercase to match the index endpoint's intake + the
        // CHECK constraint on the column. An external caller sending
        // 'Active' would otherwise 400 even though the value is valid.
        const s = String(body.status || '').toLowerCase();
        if (!VALID_STATUS.has(s)) return badRequest(res, 'Invalid status');
        push('status', s);
      }
      if ('color' in body)    push('color',     body.color    ? String(body.color).slice(0, 32) : null);
      if ('startsAt' in body) {
        // Same shape as the index endpoint: slice to 10 chars + accept
        // null. Postgres rejects malformed date strings with a 500;
        // validate the YYYY-MM-DD shape up-front.
        const v = body.startsAt ? String(body.startsAt).slice(0, 10) : null;
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return badRequest(res, 'startsAt must be YYYY-MM-DD');
        push('starts_at', v);
      }
      if ('endsAt' in body) {
        const v = body.endsAt ? String(body.endsAt).slice(0, 10) : null;
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return badRequest(res, 'endsAt must be YYYY-MM-DD');
        push('ends_at', v);
      }
      if ('amountQuoted' in body) {
        if (body.amountQuoted == null) push('amount_quoted', null);
        else {
          const n = Number(body.amountQuoted);
          if (!Number.isFinite(n) || n < 0) return badRequest(res, 'amountQuoted must be a non-negative number');
          push('amount_quoted', n);
        }
      }
      if ('notes' in body) push('notes', body.notes == null ? null : String(body.notes).slice(0, 4000));
      if ('clientId' in body) {
        const cid = body.clientId ? String(body.clientId) : null;
        if (cid) {
          const cl = await sql`SELECT id FROM clients WHERE id = ${cid} AND workspace_id = ${workspaceId}`;
          if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
        }
        push('client_id', cid);
      }

      if (sets.length === 0) {
        return ok(res, { project: serializeProject(existing) });
      }
      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE projects SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const upd = await sql.query(queryText, values);
      const row = upd.rows[0];
      let clientName = null;
      if (row.client_id) {
        const cr = await sql`SELECT name FROM clients WHERE id = ${row.client_id}`;
        clientName = cr.rows[0]?.name || null;
      }
      return ok(res, { project: serializeProject({ ...row, client_name: clientName }) });
    }

    if (req.method === 'DELETE') {
      // FK cascade: artifacts.project_id flips to NULL automatically.
      // The project row itself goes; we don't soft-delete because there's
      // no "trash bin" surface in the UI yet - owners want clean lists.
      await sql`DELETE FROM projects WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
