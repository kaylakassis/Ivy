// /api/staff
//   GET  → list workspace's staff members (active first, newest first)
//   POST → create a staff member
//
// Staff are scoped to the workspace. user_id is optional and only
// populated if the staff member has claimed their own portal login.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeStaff } from '../_lib/staff.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      try {
        const includeInactive = req.query.includeInactive === '1';
        const { rows } = includeInactive
          ? await sql`
              SELECT * FROM staff_members
               WHERE workspace_id = ${workspaceId}
               ORDER BY active DESC, created_at DESC
            `
          : await sql`
              SELECT * FROM staff_members
               WHERE workspace_id = ${workspaceId} AND active = TRUE
               ORDER BY created_at DESC
            `;
        return ok(res, { staff: rows.map(serializeStaff) });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[staff GET] failed (returning empty):', e.message);
        return ok(res, { staff: [] });
      }
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').toString().trim();
      if (!name) return badRequest(res, 'Name is required');
      if (name.length > 200) return badRequest(res, 'Name too long');
      const email = body.email ? String(body.email).trim().toLowerCase().slice(0, 200) : null;
      const phone = body.phone ? String(body.phone).trim().slice(0, 40) : null;
      const role  = body.role  ? String(body.role).slice(0, 60) : null;
      const color = body.color ? String(body.color).slice(0, 32) : null;

      const hourlyRate     = body.hourlyRate     == null ? null : Number(body.hourlyRate);
      if (hourlyRate != null && (!Number.isFinite(hourlyRate) || hourlyRate < 0)) {
        return badRequest(res, 'hourlyRate must be a non-negative number');
      }
      const commissionRate = body.commissionRate == null ? null : Number(body.commissionRate);
      if (commissionRate != null && (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100)) {
        return badRequest(res, 'commissionRate must be between 0 and 100');
      }

      const ins = await sql`
        INSERT INTO staff_members (
          workspace_id, name, email, phone, role, color,
          hourly_rate, commission_rate, active, owner_managed
        ) VALUES (
          ${workspaceId}, ${name}, ${email}, ${phone}, ${role}, ${color},
          ${hourlyRate}, ${commissionRate}, TRUE, TRUE
        )
        RETURNING *
      `;
      return created(res, { staff: serializeStaff(ins.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
