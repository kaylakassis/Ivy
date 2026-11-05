// POST /api/me/programs/:id/progress  { itemId, done: true|false }
// A member marks one of THEIR lessons complete (or undoes it). The row
// is always written for the caller's own enrollment; the body never names
// a client. Locked (dripped) lessons cannot be completed early. The owner
// previewing the program gets a 400: owners have no progress of their own.
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { readBody } from '../../../_lib/body.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { programAccess, isUuid } from '../../../_lib/programs.js';
import { loadModules, loadLessons, buildCourse, memberEnrollment, completedItemIds, lessonOpenForMember } from '../../../_lib/programCourse.js';
import { awardBadges } from '../../../_lib/programEngagement.js';
import { workspaceTimezone } from '../../../_lib/programCommerce.js';
import { badRequest, forbidden, methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const id = String(req.query.id || '');
    if (!isUuid(id)) return notFound(res, 'Program not found');
    const owner = (await sql`SELECT id FROM workspaces WHERE owner_id = ${user.id} ORDER BY created_at ASC, id ASC LIMIT 1`).rows[0]?.id || null;
    const access = await programAccess(user, id, owner);
    if (!access.program) return notFound(res, 'Program not found');
    if (access.role === 'owner') return badRequest(res, 'Progress is saved for members. This is a preview.');
    if (access.role !== 'member') return forbidden(res, 'You do not have access to this program.');
    const program = access.program;
    const enrollment = await memberEnrollment(id, access.clientId);
    if (!enrollment) return forbidden(res, 'You do not have access to this program.');
    const body = await readBody(req);
    const itemId = String(body.itemId || '');
    if (!isUuid(itemId)) return notFound(res, 'Lesson not found');
    const item = (await sql`SELECT * FROM program_items WHERE id = ${itemId} AND program_id = ${id} AND workspace_id = ${program.workspace_id} AND deleted_at IS NULL`).rows[0];
    if (!item) return notFound(res, 'Lesson not found');
    if (!(await lessonOpenForMember({ program, item, enrollment }))) return forbidden(res, 'This lesson is not open yet.');
    if (body.done === false) {
      await sql`DELETE FROM program_progress WHERE client_id = ${access.clientId} AND item_id = ${itemId} AND program_id = ${id}`;
    } else {
      await sql`
        INSERT INTO program_progress (workspace_id, program_id, enrollment_id, client_id, item_id)
        VALUES (${program.workspace_id}, ${id}, ${enrollment.id}, ${access.clientId}, ${itemId})
        ON CONFLICT (client_id, item_id) DO NOTHING`;
    }
    const modules = await loadModules(id, program.workspace_id);
    const rows = await loadLessons(id, program.workspace_id);
    const completed = await completedItemIds(id, access.clientId);
    const course = buildCourse({ program, modules, items: rows, role: 'member', enrollment, completed });
    // Badges this just earned (progress milestones, streaks), so the app
    // can celebrate right away. Best effort: never fails the save.
    let newBadges = [];
    if (body.done !== false) {
      try { newBadges = await awardBadges({ program, clientId: access.clientId, tz: await workspaceTimezone(program.workspace_id) }); } catch { newBadges = []; }
    }
    return ok(res, { itemId, done: completed.has(itemId), progress: course.progress, newBadges });
  } catch (err) { return serverError(res, err); }
}
