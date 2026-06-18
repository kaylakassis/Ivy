// /api/memberships/:id
//   GET    → fetch a single tier
//   PATCH  → edit name/description/perks/active/displayOrder. Price &
//            interval are immutable post-creation because the Stripe
//            Price is also immutable - to change pricing the owner
//            archives the tier and creates a new one. Returns a 400
//            if priceCents/interval are passed.
//   DELETE → "delete" by archiving (active=FALSE) so existing
//            subscriptions on the underlying Stripe price keep
//            working until cancelled. We don't actually drop the
//            row because client_memberships references it.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeMembership } from '../_lib/memberships.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    const r = await sql`SELECT * FROM memberships WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    const m = r.rows[0];
    if (!m) return notFound(res, 'Membership not found');

    if (req.method === 'GET') return ok(res, { membership: serializeMembership(m) });

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      // Immutable fields: refuse the request rather than silently
      // dropping the change so the owner doesn't think it took.
      if ('priceCents' in body || 'interval' in body) {
        return badRequest(res,
          "Price and interval can't be changed after creation. Archive this tier and add a new one for the new price.");
      }
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('name' in body) {
        const v = (body.name || '').toString().trim();
        if (!v) return badRequest(res, 'name is required');
        if (v.length > 200) return badRequest(res, 'name too long');
        push('name', v);
      }
      if ('description' in body) {
        push('description', body.description ? String(body.description).slice(0, 4000) : null);
      }
      if ('perks' in body) {
        const perks = Array.isArray(body.perks)
          ? body.perks.map((p) => String(p).slice(0, 200)).filter(Boolean).slice(0, 20)
          : [];
        push('perks', JSON.stringify(perks));
      }
      if ('active' in body)       push('active', !!body.active);
      if ('displayOrder' in body) push('display_order', Number.isInteger(body.displayOrder) ? body.displayOrder : 0);

      if (sets.length === 0) return ok(res, { membership: serializeMembership(m) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      let queryText = `
        UPDATE memberships SET ${sets.join(', ')}
         WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
         RETURNING *
      `;
      // perks needs ::jsonb cast.
      queryText = queryText.replace(/perks = \$(\d+)/, 'perks = $$$1::jsonb');
      const { rows } = await sql.query(queryText, values);
      return ok(res, { membership: serializeMembership(rows[0]) });
    }

    if (req.method === 'DELETE') {
      // Archive instead of hard-delete so client_memberships rows that
      // reference this tier keep their snapshot data.
      await sql`UPDATE memberships SET active = FALSE, updated_at = NOW() WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
