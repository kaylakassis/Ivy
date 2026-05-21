// /api/staff/:id
//   GET    → single staff member
//   PATCH  → update mutable fields
//   DELETE → soft delete (sets active=FALSE). Bookings.staff_id is
//            preserved so historical assignment isn't lost.
//            ?hard=1 force-deletes the row + nulls bookings.staff_id.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedStaff, serializeStaff } from '../_lib/staff.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;
    const { id } = req.query;

    const existing = await fetchOwnedStaff({ id, workspaceId });
    if (!existing) return notFound(res, 'Staff member not found');

    if (req.method === 'GET') {
      return ok(res, { staff: serializeStaff(existing) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('name' in body) {
        const v = (body.name || '').toString().trim();
        if (!v) return badRequest(res, 'Name cannot be empty');
        push('name', v.slice(0, 200));
      }
      if ('email' in body) push('email', body.email ? String(body.email).trim().toLowerCase().slice(0, 200) : null);
      if ('phone' in body) push('phone', body.phone ? String(body.phone).trim().slice(0, 40) : null);
      if ('role'  in body) push('role',  body.role  ? String(body.role).slice(0, 60)  : null);
      if ('color' in body) push('color', body.color ? String(body.color).slice(0, 32) : null);
      if ('hourlyRate' in body) {
        if (body.hourlyRate == null) push('hourly_rate', null);
        else {
          const n = Number(body.hourlyRate);
          if (!Number.isFinite(n) || n < 0) return badRequest(res, 'hourlyRate must be a non-negative number');
          push('hourly_rate', n);
        }
      }
      if ('commissionRate' in body) {
        if (body.commissionRate == null) push('commission_rate', null);
        else {
          const n = Number(body.commissionRate);
          if (!Number.isFinite(n) || n < 0 || n > 100) return badRequest(res, 'commissionRate must be 0-100');
          push('commission_rate', n);
        }
      }
      if ('active' in body) push('active', !!body.active);

      if (sets.length === 0) return ok(res, { staff: serializeStaff(existing) });
      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE staff_members SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const upd = await sql.query(queryText, values);
      return ok(res, { staff: serializeStaff(upd.rows[0]) });
    }

    if (req.method === 'DELETE') {
      // Soft-delete by default: flip active=FALSE so historical
      // bookings keep their assignment. Hard-delete with ?hard=1 only
      // for cleanup; bookings.staff_id falls back to NULL via the FK.
      if (req.query.hard === '1') {
        await sql`DELETE FROM staff_members WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      } else {
        await sql`UPDATE staff_members SET active = FALSE, updated_at = NOW()
                   WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      }
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
