// /api/projects/:id/link - put things into a folder, or take them out.
//
//   GET    → candidates: this workspace's bookings, invoices, quotes and
//            documents that are NOT yet in this folder. When the folder
//            belongs to a client, only that client's items are offered.
//   POST   { type, id }  → put one item into the folder
//   DELETE { type, id }  → take one item out (the item itself is untouched)
//
// "Folder" is the owner-facing name for a project row.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { fetchOwnedProject, invoiceTotal } from '../../_lib/projects.js';
import { isIncluded } from '../../_lib/quotes.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

const TYPES = {
  bookings:  { table: 'bookings',  clientCol: 'client_id' },
  invoices:  { table: 'invoices',  clientCol: 'client_id' },
  quotes:    { table: 'quotes',    clientCol: 'client_id' },
  documents: { table: 'documents', clientCol: 'recipient_client_id' },
};

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const id = (req.query.id || '').toString();
    const folder = await fetchOwnedProject({ id, workspaceId });
    if (!folder) return notFound(res, 'Folder not found');

    if (req.method === 'GET') {
      const cid = folder.client_id || null;
      // Offer the client's own items when the folder has a client;
      // otherwise everything in the workspace not already filed here.
      const [b, i, q, d] = await Promise.all([
        cid
          ? sql`SELECT id, date, start_min, end_min, client_name, notes FROM bookings
                 WHERE workspace_id = ${workspaceId} AND client_id = ${cid}
                   AND (project_id IS NULL OR project_id <> ${id})
                 ORDER BY date DESC, start_min DESC LIMIT 100`
          : sql`SELECT id, date, start_min, end_min, client_name, notes FROM bookings
                 WHERE workspace_id = ${workspaceId} AND (project_id IS NULL OR project_id <> ${id})
                 ORDER BY date DESC, start_min DESC LIMIT 100`,
        cid
          ? sql`SELECT id, number, status, client_name, items, tax_rate, discount FROM invoices
                 WHERE workspace_id = ${workspaceId} AND client_id = ${cid}
                   AND (project_id IS NULL OR project_id <> ${id})
                 ORDER BY created_at DESC LIMIT 100`
          : sql`SELECT id, number, status, client_name, items, tax_rate, discount FROM invoices
                 WHERE workspace_id = ${workspaceId} AND (project_id IS NULL OR project_id <> ${id})
                 ORDER BY created_at DESC LIMIT 100`,
        cid
          ? sql`SELECT id, number, status, client_name, items, tax_rate, discount FROM quotes
                 WHERE workspace_id = ${workspaceId} AND client_id = ${cid}
                   AND (project_id IS NULL OR project_id <> ${id})
                 ORDER BY created_at DESC LIMIT 100`
          : sql`SELECT id, number, status, client_name, items, tax_rate, discount FROM quotes
                 WHERE workspace_id = ${workspaceId} AND (project_id IS NULL OR project_id <> ${id})
                 ORDER BY created_at DESC LIMIT 100`,
        cid
          ? sql`SELECT id, name, status FROM documents
                 WHERE workspace_id = ${workspaceId} AND recipient_client_id = ${cid}
                   AND (project_id IS NULL OR project_id <> ${id})
                 ORDER BY updated_at DESC LIMIT 100`
          : sql`SELECT id, name, status FROM documents
                 WHERE workspace_id = ${workspaceId} AND (project_id IS NULL OR project_id <> ${id})
                 ORDER BY updated_at DESC LIMIT 100`,
      ]);
      return ok(res, {
        scopedToClient: !!cid,
        candidates: {
          bookings: b.rows.map((r) => ({
            id: r.id,
            date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date,
            startMin: r.start_min, endMin: r.end_min,
            clientName: r.client_name, notes: r.notes || null,
          })),
          invoices: i.rows.map((r) => ({ id: r.id, number: r.number, status: r.status, clientName: r.client_name, total: invoiceTotal(r) })),
          quotes: q.rows.map((r) => ({
            id: r.id, number: r.number, status: r.status, clientName: r.client_name,
            total: invoiceTotal({ ...r, items: (Array.isArray(r.items) ? r.items : []).filter(isIncluded) }),
          })),
          documents: d.rows.map((r) => ({ id: r.id, name: r.name, status: r.status })),
        },
      });
    }

    if (req.method === 'POST' || req.method === 'DELETE') {
      const body = await readBody(req);
      const type = String(body.type || '');
      const itemId = String(body.id || '');
      if (!TYPES[type]) return badRequest(res, 'type must be bookings, invoices, quotes or documents');
      if (!itemId) return badRequest(res, 'id is required');
      const target = req.method === 'POST' ? id : null;
      let r;
      if (type === 'bookings')  r = await sql`UPDATE bookings  SET project_id = ${target} WHERE id = ${itemId} AND workspace_id = ${workspaceId} RETURNING id`;
      if (type === 'invoices')  r = await sql`UPDATE invoices  SET project_id = ${target} WHERE id = ${itemId} AND workspace_id = ${workspaceId} RETURNING id`;
      if (type === 'quotes')    r = await sql`UPDATE quotes    SET project_id = ${target} WHERE id = ${itemId} AND workspace_id = ${workspaceId} RETURNING id`;
      if (type === 'documents') r = await sql`UPDATE documents SET project_id = ${target} WHERE id = ${itemId} AND workspace_id = ${workspaceId} RETURNING id`;
      if (!r || r.rows.length === 0) return notFound(res, 'Item not found');
      await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${id}`;
      return ok(res, { ok: true, type, id: itemId, linked: req.method === 'POST' });
    }

    return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
