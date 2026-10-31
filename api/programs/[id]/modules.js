// Modules (sections / weeks) inside a program (owner only).
//   POST   { title, description?, unlockAfterDays? }          → add (goes last)
//   PATCH  { moduleId, title?, description?, unlockAfterDays? } → edit
//          { order: [moduleId, ...] }                          → reorder
//   DELETE ?moduleId=                                          → soft delete; its lessons move to the top level
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { isUuid } from '../../_lib/programs.js';
import { cleanModuleInput, serializeModule } from '../../_lib/programCourse.js';
import { badRequest, created, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

const MAX_MODULES = 200;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res); if (!workspaceId) return;
    const programId = String(req.query.id || '');
    if (!isUuid(programId)) return notFound(res, 'Program not found');
    const p = (await sql`SELECT id FROM programs WHERE id = ${programId} AND workspace_id = ${workspaceId}`).rows[0];
    if (!p) return notFound(res, 'Program not found');

    if (req.method === 'POST') {
      const body = await readBody(req);
      const v = cleanModuleInput(body); if (v.error) return badRequest(res, v.error);
      const count = (await sql`SELECT COUNT(*)::int AS n, COALESCE(MAX(position), 0) + 1 AS next FROM program_modules
                               WHERE program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`).rows[0];
      if (count.n >= MAX_MODULES) return badRequest(res, `A program can have up to ${MAX_MODULES} modules.`);
      const { rows } = await sql`
        INSERT INTO program_modules (program_id, workspace_id, title, description, unlock_after_days, position)
        VALUES (${programId}, ${workspaceId}, ${v.value.title}, ${v.value.description}, ${v.value.unlock_after_days}, ${count.next})
        RETURNING *`;
      return created(res, { module: serializeModule(rows[0]) });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (Array.isArray(body.order)) {
        const order = body.order.map(String).filter(isUuid).slice(0, MAX_MODULES);
        for (let i = 0; i < order.length; i++) {
           
          await sql`UPDATE program_modules SET position = ${i + 1}, updated_at = NOW()
                    WHERE id = ${order[i]} AND program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
        }
        return ok(res, { reordered: true });
      }
      const moduleId = String(body.moduleId || '');
      if (!isUuid(moduleId)) return notFound(res, 'Module not found');
      const m = (await sql`SELECT * FROM program_modules WHERE id = ${moduleId} AND program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`).rows[0];
      if (!m) return notFound(res, 'Module not found');
      const v = cleanModuleInput(body, true); if (v.error) return badRequest(res, v.error);
      const f = { ...m, ...v.value };
      const { rows } = await sql`
        UPDATE program_modules SET title = ${f.title}, description = ${f.description}, unlock_after_days = ${f.unlock_after_days}, updated_at = NOW()
         WHERE id = ${moduleId} AND program_id = ${programId} AND workspace_id = ${workspaceId} RETURNING *`;
      return ok(res, { module: serializeModule(rows[0]) });
    }
    if (req.method === 'DELETE') {
      const moduleId = String(req.query.moduleId || '');
      if (!isUuid(moduleId)) return notFound(res, 'Module not found');
      const r = await sql`UPDATE program_modules SET deleted_at = NOW(), updated_at = NOW()
                          WHERE id = ${moduleId} AND program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL RETURNING id`;
      if (!r.rows.length) return notFound(res, 'Module not found');
      // Lessons are never lost with their module: they move to the top level.
      await sql`UPDATE program_items SET module_id = NULL, updated_at = NOW() WHERE module_id = ${moduleId} AND program_id = ${programId} AND workspace_id = ${workspaceId}`;
      return ok(res, { deleted: true });
    }
    return methodNotAllowed(res, ['POST', 'PATCH', 'DELETE']);
  } catch (err) { return serverError(res, err); }
}
