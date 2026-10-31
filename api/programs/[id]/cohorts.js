// Cohorts of a program (owner only). A cohort program drips from the
// cohort's start date instead of each member's join date.
//   GET                                            → cohorts with member counts
//   POST  { name, startDate, enrollmentClosesOn?, capacity? }  → add
//   PATCH { cohortId, name?, startDate?, enrollmentClosesOn?, capacity? } → edit
//   PATCH { action: 'move', enrollmentId, cohortId }          → move a member
//   DELETE ?cohortId=                              → remove (only when empty)
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { isUuid } from '../../_lib/programs.js';
import { cleanCohortInput, serializeCohort, loadCohorts, workspaceTimezone } from '../../_lib/programCommerce.js';
import { todayISOInZone } from '../../_lib/tz.js';
import { badRequest, created, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

const MAX_COHORTS = 100;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res); if (!workspaceId) return;
    const programId = String(req.query.id || '');
    if (!isUuid(programId)) return notFound(res, 'Program not found');
    const p = (await sql`SELECT * FROM programs WHERE id = ${programId} AND workspace_id = ${workspaceId}`).rows[0];
    if (!p) return notFound(res, 'Program not found');
    const tz = await workspaceTimezone(workspaceId);
    const list = async () => {
      const today = todayISOInZone(tz);
      return (await loadCohorts(programId, workspaceId)).map((c) => serializeCohort(c, { members: c.members, today }));
    };

    if (req.method === 'GET') {
      const unassigned = (await sql`SELECT COUNT(*)::int AS n FROM program_enrollments WHERE program_id = ${programId} AND workspace_id = ${workspaceId}
                                     AND cohort_id IS NULL AND status IN ('active','past_due')`).rows[0].n;
      return ok(res, { cohorts: await list(), unassigned, timezone: tz, delivery: p.delivery });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const n = (await sql`SELECT COUNT(*)::int AS n FROM program_cohorts WHERE program_id = ${programId} AND deleted_at IS NULL`).rows[0].n;
      if (n >= MAX_COHORTS) return badRequest(res, `A program can have up to ${MAX_COHORTS} cohorts.`);
      const v = cleanCohortInput(body, tz); if (v.error) return badRequest(res, v.error);
      const c = v.value;
      const row = (await sql`
        INSERT INTO program_cohorts (program_id, workspace_id, name, start_date, starts_at, enrollment_closes_on, capacity)
        VALUES (${programId}, ${workspaceId}, ${c.name}, ${c.start_date}, ${c.starts_at}, ${c.enrollment_closes_on}, ${c.capacity})
        RETURNING id`).rows[0];
      return created(res, { cohortId: row.id, cohorts: await list() });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (body.action === 'move') {
        const enrollmentId = String(body.enrollmentId || '');
        const cohortId = body.cohortId ? String(body.cohortId) : null;
        if (!isUuid(enrollmentId)) return notFound(res, 'Member not found');
        if (cohortId && !isUuid(cohortId)) return notFound(res, 'Cohort not found');
        if (cohortId) {
          const c = (await sql`SELECT id FROM program_cohorts WHERE id = ${cohortId} AND program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`).rows[0];
          if (!c) return notFound(res, 'Cohort not found');
        }
        const r = await sql`UPDATE program_enrollments SET cohort_id = ${cohortId}::uuid, updated_at = NOW()
                            WHERE id = ${enrollmentId} AND program_id = ${programId} AND workspace_id = ${workspaceId} RETURNING id`;
        if (!r.rows.length) return notFound(res, 'Member not found');
        return ok(res, { moved: true, cohortId, cohorts: await list() });
      }
      const cohortId = String(body.cohortId || '');
      if (!isUuid(cohortId)) return notFound(res, 'Cohort not found');
      const cur = (await sql`SELECT * FROM program_cohorts WHERE id = ${cohortId} AND program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`).rows[0];
      if (!cur) return notFound(res, 'Cohort not found');
      const v = cleanCohortInput(body, tz, true); if (v.error) return badRequest(res, v.error);
      const c = v.value;
      await sql`
        UPDATE program_cohorts SET
          name = COALESCE(${c.name ?? null}, name),
          start_date = COALESCE(${c.start_date ?? null}::date, start_date),
          starts_at = COALESCE(${c.starts_at ?? null}::timestamptz, starts_at),
          enrollment_closes_on = CASE WHEN ${c.enrollment_closes_on !== undefined} THEN ${c.enrollment_closes_on ?? null}::date ELSE enrollment_closes_on END,
          capacity = CASE WHEN ${c.capacity !== undefined} THEN ${c.capacity ?? null}::int ELSE capacity END,
          updated_at = NOW()
         WHERE id = ${cohortId} AND workspace_id = ${workspaceId}`;
      return ok(res, { cohorts: await list() });
    }
    if (req.method === 'DELETE') {
      const cohortId = String(req.query.cohortId || '');
      if (!isUuid(cohortId)) return notFound(res, 'Cohort not found');
      const used = (await sql`SELECT COUNT(*)::int AS n FROM program_enrollments WHERE cohort_id = ${cohortId} AND status IN ('active','past_due')`).rows[0].n;
      if (used) return badRequest(res, 'Move this cohort\'s members to another cohort first.');
      const r = await sql`UPDATE program_cohorts SET deleted_at = NOW(), updated_at = NOW()
                          WHERE id = ${cohortId} AND program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL RETURNING id`;
      if (!r.rows.length) return notFound(res, 'Cohort not found');
      return ok(res, { deleted: true, cohorts: await list() });
    }
    return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  } catch (err) { return serverError(res, err); }
}
