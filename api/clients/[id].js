// /api/clients/:id
//   GET    → single client (workspace-scoped)
//   PATCH  → update name / email / stage / tags / notes / lifetime_value / last_seen_at
//   DELETE → remove

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { fetchOwnedClient, serializeClient, VALID_STAGES } from '../_lib/clients.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const existing = await fetchOwnedClient({ id, workspaceId });
    if (!existing) return notFound(res, 'Client not found');

    if (req.method === 'GET') {
      return ok(res, { client: serializeClient(existing) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('name' in body) {
        const v = (body.name || '').toString().trim();
        if (!v) return badRequest(res, 'Name cannot be empty');
        if (v.length > 120) return badRequest(res, 'Name too long');
        push('name', v);
      }
      if ('email' in body) push('email', body.email ? body.email.toString().trim().toLowerCase() : null);
      if ('stage' in body) {
        if (!VALID_STAGES.has(body.stage)) return badRequest(res, 'Invalid stage');
        push('stage', body.stage);
      }
      if ('tags' in body) {
        if (!Array.isArray(body.tags)) return badRequest(res, 'Tags must be an array of strings');
        push('tags', body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20));
      }
      if ('notes' in body) push('notes', body.notes == null ? null : String(body.notes).slice(0, 4000));
      if ('lifetimeValue' in body) {
        const n = Number(body.lifetimeValue);
        if (!Number.isFinite(n) || n < 0) return badRequest(res, 'lifetimeValue must be a non-negative number');
        push('lifetime_value', n);
      }
      if ('source' in body) push('source', body.source ? String(body.source).slice(0, 60) : null);
      if ('lastSeenAt' in body) push('last_seen_at', body.lastSeenAt ? new Date(body.lastSeenAt).toISOString() : null);

      if (sets.length === 0) return ok(res, { client: serializeClient(existing) });

      sets.push(`updated_at = NOW()`);
      values.push(id, workspaceId);
      const queryText = `
        UPDATE clients SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { client: serializeClient(rows[0]) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM clients WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
