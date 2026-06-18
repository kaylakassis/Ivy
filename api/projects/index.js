// /api/projects
//   GET  → list workspace's projects (filterable by status + clientId)
//   POST → create a new project
//
// List response embeds artifact counts (bookings, invoices, quotes,
// documents) per project so the UI doesn't need follow-up fetches just
// to render "3 invoices · 2 bookings · 1 doc" subtitles.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeProject, VALID_STATUS } from '../_lib/projects.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (req.method === 'GET') {
      const status   = (req.query.status   || '').toString().toLowerCase();
      const clientId = (req.query.clientId || '').toString();

      // Build the WHERE dynamically - kept parameterized to avoid
      // injection. status + clientId are both optional, both
      // composable; the index on (workspace_id, status, updated_at)
      // covers the common dashboard query.
      const where = ['p.workspace_id = $1'];
      const params = [workspaceId];
      if (status && VALID_STATUS.has(status)) {
        params.push(status);
        where.push(`p.status = $${params.length}`);
      }
      if (clientId) {
        params.push(clientId);
        where.push(`p.client_id = $${params.length}`);
      }

      // If any of the project_id subquery columns hasn't migrated yet,
      // the subqueries 500 the whole list. Try the rich query first;
      // on column-missing, retry with the simple version (no counts).
      //
      // Counts used to be four correlated subqueries per row, so a
      // workspace with 200 projects ran 800 COUNT(*) scans per request.
      // Now each related table is scanned once and grouped, then joined.
      let rows;
      try {
        ({ rows } = await sql.query(
          `SELECT p.*,
                  c.name AS client_name,
                  COALESCE(bc.cnt, 0)::int AS booking_count,
                  COALESCE(ic.cnt, 0)::int AS invoice_count,
                  COALESCE(qc.cnt, 0)::int AS quote_count,
                  COALESCE(dc.cnt, 0)::int AS document_count
             FROM projects p
             LEFT JOIN clients c ON c.id = p.client_id AND c.workspace_id = p.workspace_id
             -- Subqueries are workspace-scoped via $1 (same param the outer
             -- WHERE uses) so a cross-workspace project_id collision can't
             -- inflate counts or leak existence of artifacts in another tenant.
             LEFT JOIN (SELECT project_id, COUNT(*) AS cnt FROM bookings  WHERE project_id IS NOT NULL AND workspace_id = $1 GROUP BY project_id) bc ON bc.project_id = p.id
             LEFT JOIN (SELECT project_id, COUNT(*) AS cnt FROM invoices  WHERE project_id IS NOT NULL AND workspace_id = $1 GROUP BY project_id) ic ON ic.project_id = p.id
             LEFT JOIN (SELECT project_id, COUNT(*) AS cnt FROM quotes    WHERE project_id IS NOT NULL AND workspace_id = $1 GROUP BY project_id) qc ON qc.project_id = p.id
             LEFT JOIN (SELECT project_id, COUNT(*) AS cnt FROM documents WHERE project_id IS NOT NULL AND workspace_id = $1 GROUP BY project_id) dc ON dc.project_id = p.id
            WHERE ${where.join(' AND ')}
            ORDER BY p.updated_at DESC
            LIMIT 200`,
          params,
        ));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[projects GET] rich query failed; falling back:', e.message);
        try {
          ({ rows } = await sql.query(
            `SELECT p.*, c.name AS client_name,
                    0 AS booking_count, 0 AS invoice_count,
                    0 AS quote_count, 0 AS document_count
               FROM projects p
               LEFT JOIN clients c ON c.id = p.client_id AND c.workspace_id = p.workspace_id
              WHERE ${where.join(' AND ')}
              ORDER BY p.updated_at DESC
              LIMIT 200`,
            params,
          ));
        } catch (e2) {
          // eslint-disable-next-line no-console
          console.error('[projects GET] fallback also failed (returning empty):', e2.message);
          return ok(res, { projects: [] });
        }
      }

      return ok(res, {
        projects: rows.map((r) => serializeProject(r, {
          bookings:  r.booking_count  || 0,
          invoices:  r.invoice_count  || 0,
          quotes:    r.quote_count    || 0,
          documents: r.document_count || 0,
        })),
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').toString().trim();
      if (!name) return badRequest(res, 'Name is required');
      if (name.length > 200) return badRequest(res, 'Name too long');

      const status = (body.status || 'active').toString().toLowerCase();
      if (!VALID_STATUS.has(status)) return badRequest(res, 'Invalid status');

      // Verify the client (if supplied) belongs to this workspace -
      // never trust the browser-sent id alone.
      const clientId = body.clientId ? String(body.clientId) : null;
      if (clientId) {
        const cl = await sql`
          SELECT id FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}
        `;
        if (cl.rows.length === 0) return badRequest(res, 'Unknown client');
      }

      const description  = body.description  ? String(body.description).slice(0, 4000) : null;
      const color        = body.color        ? String(body.color).slice(0, 32)        : null;
      const notes        = body.notes        ? String(body.notes).slice(0, 4000)      : null;
      const startsAt     = body.startsAt     ? String(body.startsAt).slice(0, 10)     : null;
      const endsAt       = body.endsAt       ? String(body.endsAt).slice(0, 10)       : null;
      const amountQuoted = body.amountQuoted == null ? null : Number(body.amountQuoted);
      if (amountQuoted != null && !(Number.isFinite(amountQuoted) && amountQuoted >= 0)) {
        return badRequest(res, 'amountQuoted must be a non-negative number');
      }

      const ins = await sql`
        INSERT INTO projects (
          workspace_id, client_id, name, description, status,
          color, starts_at, ends_at, amount_quoted, notes
        ) VALUES (
          ${workspaceId}, ${clientId}, ${name}, ${description}, ${status},
          ${color}, ${startsAt}, ${endsAt}, ${amountQuoted}, ${notes}
        )
        RETURNING *
      `;
      const row = ins.rows[0];
      let clientName = null;
      if (row.client_id) {
        const cr = await sql`SELECT name FROM clients WHERE id = ${row.client_id}`;
        clientName = cr.rows[0]?.name || null;
      }
      return created(res, {
        project: serializeProject({ ...row, client_name: clientName }, {
          bookings: 0, invoices: 0, quotes: 0, documents: 0,
        }),
      });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
