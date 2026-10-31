// /api/staff
//   GET  → list workspace's staff members (active first, newest first)
//   POST → create a staff member
//
// Staff are scoped to the workspace. user_id is optional and only
// populated once the owner invited the staff member to Ivy as a HELPER
// and they accepted (api/_lib/helpers.js). GET also returns the helper
// seat usage; POST { invite: true } creates the record and sends the
// invite in one step ("Add helper").
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeStaff } from '../_lib/staff.js';
import {
  HELPER_SEATS, helperFieldsFor, helperSeatUsage, inviteHelper, pendingInvitesByStaff, HelperError,
  normalizePermissions,
} from '../_lib/helpers.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    // Helpers with the schedule permission may LIST staff (to assign a
    // booking to someone); creating/editing staff stays owner-only.
    const workspaceId = await ensureActiveWorkspace(user, req, res, {
      helper: req.method === 'GET' ? 'schedule' : undefined,
    });
    if (!workspaceId) return;
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
        const [pending, seats] = await Promise.all([
          pendingInvitesByStaff(workspaceId),
          helperSeatUsage(workspaceId).catch(() => ({ attached: 0, pending: 0, used: 0, seats: HELPER_SEATS })),
        ]);
        return ok(res, {
          staff: rows.map((r) => serializeStaff(r, helperFieldsFor(r, pending.get(r.id)))),
          helperSeats: seats,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[staff GET] failed (returning empty):', e.message);
        return ok(res, { staff: [], helperSeats: { attached: 0, pending: 0, used: 0, seats: HELPER_SEATS } });
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

      // "Add helper": create + invite in one step. Check what inviteHelper
      // would refuse BEFORE inserting so a full roster or the owner's own
      // email doesn't leave a stray record behind.
      const wantInvite = body.invite === true;
      if (wantInvite) {
        if (!email) return badRequest(res, 'An email is required to invite a helper.');
        if (user.email && email === user.email.toLowerCase()) {
          return badRequest(res, 'That is your own email. Helpers need their own sign-in.');
        }
        const usage = await helperSeatUsage(workspaceId);
        if (usage.used >= HELPER_SEATS) {
          return res.status(409).json({ error: `Ivy includes ${HELPER_SEATS} helpers. Revoke one to invite another.` });
        }
      }

      const permissions = normalizePermissions(body.permissions);
      const ins = await sql`
        INSERT INTO staff_members (
          workspace_id, name, email, phone, role, color,
          hourly_rate, commission_rate, active, owner_managed, permissions
        ) VALUES (
          ${workspaceId}, ${name}, ${email}, ${phone}, ${role}, ${color},
          ${hourlyRate}, ${commissionRate}, TRUE, TRUE, ${JSON.stringify(permissions)}::jsonb
        )
        RETURNING *
      `;
      let row = ins.rows[0];
      let invite = null;
      if (wantInvite) {
        try {
          invite = await inviteHelper({ workspaceId, owner: user, staff: row });
          row = (await sql`SELECT * FROM staff_members WHERE id = ${row.id} AND workspace_id = ${workspaceId}`).rows[0] || row;
        } catch (e) {
          if (!(e instanceof HelperError)) throw e;
          // Record exists, invite didn't go out - say so plainly.
          return res.status(e.status).json({ error: e.message, staff: serializeStaff(row, helperFieldsFor(row, null)) });
        }
      }
      const pending = invite ? { expiresAt: invite.expiresAt } : null;
      return created(res, { staff: serializeStaff(row, helperFieldsFor(row, pending)), invite });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
