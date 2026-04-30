// /api/calendar/bookings/:id
//   PATCH  → edit fields (notes, recurrence rule, etc.) or cancel a single
//            occurrence by passing { cancelOccurrence: 'YYYY-MM-DD' }
//   DELETE → soft-cancel the entire booking (and its series if recurring)
import { sql } from '../../_lib/db.js';
import { requireUser, ensureWorkspace } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { serializeBooking, VALID_RECURRENCE } from '../../_lib/calendar.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';
import { requireSameOrigin } from "../../_lib/security.js";

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const found = await sql`
      SELECT * FROM bookings WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
    if (found.rows.length === 0) return notFound(res, 'Booking not found');

    if (req.method === 'PATCH') {
      const body = await readBody(req);

      // Convenience: cancel a single occurrence in a recurring series.
      if (body.cancelOccurrence) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.cancelOccurrence)) {
          return badRequest(res, 'cancelOccurrence must be YYYY-MM-DD');
        }
        const updated = await sql`
          UPDATE bookings
          SET cancelled_occurrences = CASE
            WHEN ${body.cancelOccurrence}::date = ANY(cancelled_occurrences) THEN cancelled_occurrences
            ELSE array_append(cancelled_occurrences, ${body.cancelOccurrence}::date)
          END
          WHERE id = ${id} AND workspace_id = ${workspaceId}
          RETURNING *
        `;
        return ok(res, { booking: serializeBooking(updated.rows[0]) });
      }

      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('notes' in body)            push('notes', body.notes == null ? null : String(body.notes).slice(0, 4000));
      if ('recurrenceRule' in body) {
        if (!VALID_RECURRENCE.has(body.recurrenceRule)) return badRequest(res, 'Invalid recurrence rule');
        push('recurrence_rule', body.recurrenceRule);
      }
      if ('recurrenceUntil' in body) {
        if (body.recurrenceUntil && !/^\d{4}-\d{2}-\d{2}$/.test(body.recurrenceUntil)) {
          return badRequest(res, 'recurrenceUntil must be YYYY-MM-DD');
        }
        push('recurrence_until', body.recurrenceUntil || null);
      }

      if (sets.length === 0) return ok(res, { booking: serializeBooking(found.rows[0]) });

      values.push(id, workspaceId);
      const queryText = `
        UPDATE bookings SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { booking: serializeBooking(rows[0]) });
    }

    if (req.method === 'DELETE') {
      const r = await sql`
        UPDATE bookings SET cancelled_at = NOW()
        WHERE id = ${id} AND workspace_id = ${workspaceId} AND cancelled_at IS NULL
      `;
      if (r.rowCount === 0) return notFound(res, 'Booking not found or already cancelled');
      return noContent(res);
    }

    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
