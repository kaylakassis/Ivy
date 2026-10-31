// Content inside a program (owner only).
//   POST   { type, title, body?, fileUrl?, fileName?, youtube?|videoUrl?, mediaUrl?, mediaName?,
//            images?, attachments?, isPreview?, moduleId?, notify? }      → add
//   PATCH  { itemId, ...fields, moduleId? }                                → edit / move to a module
//          { order: [itemId, ...], moduleId? }                             → reorder (and, with
//                                                                            moduleId, place them in it)
//   DELETE ?itemId=                                                        → soft delete (never touches access)
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { ITEM_TYPES, isUuid } from '../../_lib/programs.js';
import { cleanLesson, lessonInputFromRow, serializeLesson } from '../../_lib/programCourse.js';
import { notifyNewLesson } from '../../_lib/programNotify.js';
import { badRequest, created, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

// undefined = not sent; null = top level; otherwise a live module of this program.
async function resolveModule(raw, programId, workspaceId) {
  if (raw === undefined) return { value: undefined };
  if (raw === null || raw === '') return { value: null };
  const id = String(raw);
  if (!isUuid(id)) return { error: 'Module not found' };
  const m = (await sql`SELECT id FROM program_modules WHERE id = ${id} AND program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`).rows[0];
  return m ? { value: m.id } : { error: 'Module not found' };
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res); if (!workspaceId) return;
    const programId = String(req.query.id || '');
    if (!isUuid(programId)) return notFound(res, 'Program not found');
    const p = (await sql`SELECT id, status FROM programs WHERE id = ${programId} AND workspace_id = ${workspaceId}`).rows[0];
    if (!p) return notFound(res, 'Program not found');

    if (req.method === 'POST') {
      const body = await readBody(req);
      const type = String(body.type || '');
      if (!ITEM_TYPES.has(type)) return badRequest(res, 'Type must be pdf, post, video or audio.');
      const c = cleanLesson(body, type, workspaceId); if (c.error) return badRequest(res, c.error);
      const mod = await resolveModule(body.moduleId, programId, workspaceId); if (mod.error) return notFound(res, mod.error);
      const moduleId = mod.value || null;
      const pos = (await sql`SELECT COALESCE(MAX(position), 0) + 1 AS n FROM program_items WHERE program_id = ${programId}`).rows[0].n;
      const v = c.value;
      const { rows } = await sql`
        INSERT INTO program_items (program_id, workspace_id, module_id, type, title, body, file_url, file_name, youtube_id,
          video_provider, video_ref, media_url, media_name, images, attachments, is_preview, position)
        VALUES (${programId}, ${workspaceId}, ${moduleId}, ${type}, ${v.title}, ${v.body}, ${v.file_url}, ${v.file_name}, ${v.youtube_id},
          ${v.video_provider}, ${v.video_ref}, ${v.media_url}, ${v.media_name}, ${JSON.stringify(v.images)}::jsonb, ${JSON.stringify(v.attachments)}::jsonb, ${v.is_preview}, ${pos})
        RETURNING *`;
      // "Notify members" (on by default) for a published program.
      let notified = null;
      if (body.notify !== false && p.status === 'published') {
        notified = await notifyNewLesson({ workspaceId, programId, itemId: rows[0].id }).catch((e) => { console.warn('[items] notify', e.message); return null; });
      }
      return created(res, { item: serializeLesson(rows[0]), notified: notified ? notified.sent : 0 });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if (Array.isArray(body.order)) {
        const order = body.order.map(String).filter(isUuid).slice(0, 500);
        const mod = await resolveModule(body.moduleId, programId, workspaceId); if (mod.error) return notFound(res, mod.error);
        for (let i = 0; i < order.length; i++) {
          if (mod.value === undefined) {
             
            await sql`UPDATE program_items SET position = ${i + 1}, updated_at = NOW() WHERE id = ${order[i]} AND program_id = ${programId} AND workspace_id = ${workspaceId}`;
          } else {
             
            await sql`UPDATE program_items SET position = ${i + 1}, module_id = ${mod.value}, updated_at = NOW() WHERE id = ${order[i]} AND program_id = ${programId} AND workspace_id = ${workspaceId}`;
          }
        }
        return ok(res, { reordered: true });
      }
      const itemId = String(body.itemId || '');
      if (!isUuid(itemId)) return notFound(res, 'Item not found');
      const it = (await sql`SELECT * FROM program_items WHERE id = ${itemId} AND program_id = ${programId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`).rows[0];
      if (!it) return notFound(res, 'Item not found');
      const mod = await resolveModule(body.moduleId, programId, workspaceId); if (mod.error) return notFound(res, mod.error);
      const { itemId: _i, moduleId: _m, type: _t, order: _o, notify: _n, ...fields } = body;
      const merged = { ...lessonInputFromRow(it), ...fields };
      // Older builders send the link as `youtube`; it wins over the stored link.
      if (fields.youtube !== undefined && fields.videoUrl === undefined) merged.videoUrl = fields.youtube;
      const c = cleanLesson(merged, it.type, workspaceId); if (c.error) return badRequest(res, c.error);
      const v = c.value;
      let moduleId = it.module_id; let position = it.position;
      if (mod.value !== undefined && mod.value !== it.module_id) {
        // Moving to another module: it goes to the end of that module.
        moduleId = mod.value;
        position = (await sql`SELECT COALESCE(MAX(position), 0) + 1 AS n FROM program_items WHERE program_id = ${programId} AND deleted_at IS NULL
                              AND module_id IS NOT DISTINCT FROM ${moduleId}::uuid`).rows[0].n;
      }
      const { rows } = await sql`
        UPDATE program_items SET title = ${v.title}, body = ${v.body}, file_url = ${v.file_url}, file_name = ${v.file_name},
          youtube_id = ${v.youtube_id}, video_provider = ${v.video_provider}, video_ref = ${v.video_ref}, media_url = ${v.media_url},
          media_name = ${v.media_name}, images = ${JSON.stringify(v.images)}::jsonb, attachments = ${JSON.stringify(v.attachments)}::jsonb,
          is_preview = ${v.is_preview}, module_id = ${moduleId}, position = ${position}, updated_at = NOW()
        WHERE id = ${itemId} AND program_id = ${programId} AND workspace_id = ${workspaceId} RETURNING *`;
      return ok(res, { item: serializeLesson(rows[0]) });
    }
    if (req.method === 'DELETE') {
      const itemId = String(req.query.itemId || '');
      if (!isUuid(itemId)) return notFound(res, 'Item not found');
      await sql`UPDATE program_items SET deleted_at = NOW() WHERE id = ${itemId} AND program_id = ${programId} AND workspace_id = ${workspaceId}`;
      return ok(res, { deleted: true });
    }
    return methodNotAllowed(res, ['POST', 'PATCH', 'DELETE']);
  } catch (err) { return serverError(res, err); }
}
