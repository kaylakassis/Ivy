// GET /api/me/programs/:id → the course for an enrolled client (or the
// owner previewing it).
//
// Drip is enforced HERE, not in the UI: a lesson in a module that has not
// opened for this member yet is sent as an outline row only (title, type,
// module, unlocksAt) with no body, file, media, video id, images or
// attachments. `items` (read by the iPhone app already in the store) holds
// only the lessons the member may open; `lessons` / `modules` / `progress`
// are the course view newer clients render.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { programAccess, serializeProgram, isUuid } from '../../_lib/programs.js';
import { loadModules, loadLessons, buildCourse, memberEnrollment, completedItemIds } from '../../_lib/programCourse.js';
import { forbidden, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const id = String(req.query.id || '');
    if (!isUuid(id)) return notFound(res, 'Program not found');
    const owner = (await sql`SELECT id FROM workspaces WHERE owner_id = ${user.id} LIMIT 1`).rows[0]?.id || null;
    const access = await programAccess(user, id, owner);
    if (!access.program) return notFound(res, 'Program not found');
    if (!access.role) return forbidden(res, 'You do not have access to this program.');
    const program = access.program;
    const wid = program.workspace_id;
    const modules = await loadModules(id, wid);
    const rows = await loadLessons(id, wid);
    const enrollment = access.role === 'member' ? await memberEnrollment(id, access.clientId) : null;
    if (access.role === 'member' && !enrollment) return forbidden(res, 'You do not have access to this program.');
    const completed = access.role === 'member' ? await completedItemIds(id, access.clientId) : new Set();
    const course = buildCourse({ program, modules, items: rows, role: access.role, enrollment, completed });
    const biz = (await sql`SELECT cs.biz_name, w.name FROM workspaces w LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id WHERE w.id = ${wid}`).rows[0];
    return ok(res, {
      program: serializeProgram(program, { businessName: biz?.biz_name || biz?.name || 'Business', lessons: course.lessons.length }),
      items: course.items, lessons: course.lessons, modules: course.modules, progress: course.progress,
      role: access.role, joinedAt: enrollment?.granted_at || null,
      // Cohort programs: the member's cohort and whether it has started
      // (before the start only "available before start" modules are open).
      cohort: program.delivery === 'cohort' && enrollment?.cohort_starts_at
        ? { name: enrollment.cohort_name, startDate: enrollment.cohort_start_date, startsAt: enrollment.cohort_starts_at, started: new Date(enrollment.cohort_starts_at).getTime() <= Date.now() }
        : null,
      trialEndsAt: enrollment?.trialing ? (enrollment.trial_ends_at || null) : null,
    });
  } catch (err) { return serverError(res, err); }
}
