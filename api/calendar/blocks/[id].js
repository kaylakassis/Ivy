// /api/calendar/blocks/:id
//   PATCH  → update block (date / start_min / end_min / label)
//   DELETE → remove block
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { serializeBlock } from '../../_lib/calendar.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';
import { requireSameOrigin } from "../../_lib/security.js";

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    const found = await sql`SELECT * FROM calendar_blocks WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    if (found.rows.length === 0) return notFound(res, 'Block not found');

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('date' in body) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return badRequest(res, 'date must be YYYY-MM-DD');
        push('date', body.date);
      }
      if ('startMin' in body) {
        const n = Number(body.startMin);
        if (!Number.isInteger(n) || n < 0 || n >= 24 * 60) return badRequest(res, 'invalid startMin');
        push('start_min', n);
      }
      if ('endMin' in body) {
        const n = Number(body.endMin);
        if (!Number.isInteger(n) || n <= 0 || n > 24 * 60) return badRequest(res, 'invalid endMin');
        push('end_min', n);
      }
      if ('label' in body) push('label', body.label ? String(body.label).slice(0, 120) : null);
      // Event fields. All optional + validated; unknown fields silently
      // ignored per the existing PATCH convention.
      if ('blocksBookings' in body) push('blocks_bookings', !!body.blocksBookings);
      if ('color' in body) {
        const c = body.color;
        if (c === null || c === '') push('color', null);
        else if (typeof c === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) push('color', c);
        else return badRequest(res, 'color must be #RGB or #RRGGBB');
      }
      if ('notes' in body) push('notes', body.notes ? String(body.notes).slice(0, 2000) : null);
      if ('allDay' in body) push('all_day', !!body.allDay);

      if (sets.length === 0) return ok(res, { block: serializeBlock(found.rows[0]) });

      values.push(id, workspaceId);
      const queryText = `
        UPDATE calendar_blocks SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { block: serializeBlock(rows[0]) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM calendar_blocks WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
