// /api/clients/fields - the business's own client fields ("Custom fields").
//   GET    → { fields: [{ id, label, type, options, position }], max,
//              dateOrder: 'mdy' | 'dmy' }   (owner, or a helper with the
//              clients permission, who needs them to show a profile)
//   POST   { label, type, options? }        → { field }   owner only
//   PATCH  { id, label?, options? }         → { field }   owner only
//          { order: [id, ...] }             → { fields }  owner only
//   DELETE ?id=…                            → 204, and the field's values
//                                             are removed from every client
//
// type: text | number | date | boolean (yes/no) | select (dropdown). The
// type cannot change after creation (stored values would stop fitting).
// Caps: 25 fields per business, 30 choices per dropdown (clientDetails.js).
// Every query is scoped by the workspace from the session.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import {
  loadFieldDefs, createFieldDef, cleanFieldDef, serializeFieldDef, workspaceDateOrder,
  ClientDetailError, CUSTOM_FIELD_MAX,
} from '../_lib/clientDetails.js';
import { badRequest, created, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res, {
      helper: req.method === 'GET' ? 'clients' : undefined,
    });
    if (!workspaceId) return;

    if (req.method === 'GET') {
      const [fields, dateOrder] = await Promise.all([loadFieldDefs(workspaceId), workspaceDateOrder(workspaceId)]);
      return ok(res, { fields, max: CUSTOM_FIELD_MAX, dateOrder });
    }

    if (await enforce(req, res, [{ key: `client-fields:ws:${workspaceId}`, max: 120, windowSeconds: 3600 }])) return;
    const body = req.method === 'DELETE' ? {} : await readBody(req);

    try {
      if (req.method === 'POST') {
        const field = await createFieldDef(workspaceId, body || {});
        return created(res, { field });
      }

      if (req.method === 'PATCH') {
        if (Array.isArray(body.order)) {
          const ids = body.order.map(String).filter((x) => UUID.test(x)).slice(0, CUSTOM_FIELD_MAX * 2);
          for (let i = 0; i < ids.length; i++) {
            await sql`UPDATE client_field_definitions SET position = ${i}, updated_at = NOW()
                       WHERE id = ${ids[i]} AND workspace_id = ${workspaceId}`;
          }
          return ok(res, { fields: await loadFieldDefs(workspaceId) });
        }
        const id = String(body.id || '');
        if (!UUID.test(id)) return badRequest(res, 'id is required');
        if ('type' in body) {
          const cur = await sql`SELECT type FROM client_field_definitions WHERE id = ${id} AND workspace_id = ${workspaceId}`;
          if (cur.rows[0] && cur.rows[0].type !== body.type) return badRequest(res, "A field's type can't change. Make a new field instead.");
        }
        const patch = cleanFieldDef(body, { partial: true });
        const { rows } = await sql`
          UPDATE client_field_definitions
             SET label = COALESCE(${patch.label ?? null}, label),
                 options = COALESCE(${patch.options ? JSON.stringify(patch.options) : null}::jsonb, options),
                 updated_at = NOW()
           WHERE id = ${id} AND workspace_id = ${workspaceId}
          RETURNING id, label, type, options, position`;
        if (!rows.length) return notFound(res, 'Field not found');
        return ok(res, { field: serializeFieldDef(rows[0]) });
      }

      // DELETE
      const id = String(req.query?.id || '');
      if (!UUID.test(id)) return badRequest(res, 'id is required');
      const del = await sql`DELETE FROM client_field_definitions WHERE id = ${id} AND workspace_id = ${workspaceId} RETURNING id`;
      if (!del.rows.length) return notFound(res, 'Field not found');
      await sql`UPDATE clients SET custom_fields = custom_fields - ${id}::text
                 WHERE workspace_id = ${workspaceId} AND custom_fields ? ${id}::text`;
      return noContent(res);
    } catch (e) {
      if (e instanceof ClientDetailError) return badRequest(res, e.message);
      if (e.code === '23505') return badRequest(res, 'You already have a field with that name');
      throw e;
    }
  } catch (err) {
    return serverError(res, err);
  }
}
