// /api/time-entries/:id
//   GET    → fetch one entry
//   PATCH  → edit (description, client, service, hourlyRate, billable,
//            startedAt/endedAt). Won't edit billed entries.
//   DELETE → remove
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeEntry, fetchOwnedEntry } from '../_lib/timeEntries.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const e = await fetchOwnedEntry(id, workspaceId);
    if (!e) return notFound(res, 'Time entry not found');

    if (req.method === 'GET') {
      return ok(res, { entry: serializeEntry(e) });
    }

    if (req.method === 'PATCH') {
      if (e.status === 'billed') return badRequest(res, "Can't edit a billed entry");
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('description' in body) {
        push('description', body.description ? String(body.description).slice(0, 1000) : null);
      }
      if ('clientId' in body) {
        const cid = body.clientId ? String(body.clientId) : null;
        if (cid) {
          const c = await sql`SELECT id FROM clients WHERE id = ${cid} AND workspace_id = ${workspaceId}`;
          if (c.rows.length === 0) return badRequest(res, 'Unknown client');
        }
        push('client_id', cid);
      }
      if ('serviceId' in body) {
        const sid = body.serviceId ? String(body.serviceId) : null;
        if (sid) {
          const s = await sql`SELECT id FROM services WHERE id = ${sid} AND workspace_id = ${workspaceId}`;
          if (s.rows.length === 0) return badRequest(res, 'Unknown service');
        }
        push('service_id', sid);
      }
      if ('hourlyRate' in body) {
        const n = Number(body.hourlyRate);
        if (!Number.isFinite(n) || n < 0) return badRequest(res, 'hourlyRate must be non-negative');
        push('hourly_rate', n);
      }
      if ('billable' in body) push('billable', !!body.billable);

      // Manual edits to start/end times. Recompute duration if either
      // changes so the row stays consistent.
      let recompute = false;
      if ('startedAt' in body) {
        const v = body.startedAt ? new Date(body.startedAt) : null;
        if (!v || Number.isNaN(v.getTime())) return badRequest(res, 'invalid startedAt');
        push('started_at', v.toISOString());
        recompute = true;
      }
      if ('endedAt' in body) {
        const v = body.endedAt ? new Date(body.endedAt) : null;
        if (body.endedAt && (!v || Number.isNaN(v.getTime()))) return badRequest(res, 'invalid endedAt');
        push('ended_at', v ? v.toISOString() : null);
        recompute = true;
      }
      // Manual duration override (decimal hours preferred from UI).
      if ('durationSeconds' in body) {
        const n = parseInt(body.durationSeconds, 10);
        if (!Number.isInteger(n) || n < 0) return badRequest(res, 'durationSeconds must be non-negative');
        push('duration_seconds', n);
        recompute = false; // explicit override wins
      } else if (recompute) {
        // Compute server-side from the (possibly updated) start/end pair.
        const startStr = body.startedAt || (e.started_at instanceof Date ? e.started_at.toISOString() : e.started_at);
        const endStr   = 'endedAt' in body ? body.endedAt : (e.ended_at instanceof Date ? e.ended_at.toISOString() : e.ended_at);
        if (startStr && endStr) {
          const ms = new Date(endStr).getTime() - new Date(startStr).getTime();
          push('duration_seconds', Math.max(0, Math.round(ms / 1000)));
        }
      }

      if (sets.length === 0) return ok(res, { entry: serializeEntry(e) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE time_entries SET ${sets.join(', ')}
         WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
         RETURNING id
      `;
      await sql.query(queryText, values);
      const fresh = await fetchOwnedEntry(id, workspaceId);
      return ok(res, { entry: serializeEntry(fresh) });
    }

    if (req.method === 'DELETE') {
      if (e.status === 'billed') return badRequest(res, "Can't delete a billed entry");
      await sql`DELETE FROM time_entries WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
