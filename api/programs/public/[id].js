// GET /api/programs/public/:id → what a buyer sees before purchase.
// Published programs only. Content bodies and files are NOT included -
// only titles and types, so the outline can be shown without leaking it.
// The one exception: lessons the owner marked as a free preview, which
// are sent in full under `previews` so anyone can watch / read them.
import { sql } from '../../_lib/db.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { serializeProgram, isUuid } from '../../_lib/programs.js';
import { loadModules, loadLessons, courseOrder, serializeLesson } from '../../_lib/programCourse.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';
import { loadWorkspaceAccess, archivedPayload } from '../../_lib/businessAccess.js';
import { openCohorts, bundleFor, serializeBundle } from '../../_lib/programCommerce.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const blocked = await enforce(req, res, [{ key: `program:pub:${getClientIp(req)}`, max: 120, windowSeconds: 60 * 10 }]);
    if (blocked) return;
    const id = String(req.query.id || '');
    if (!isUuid(id)) return notFound(res, 'This program is not available.');
    const p = (await sql`
      SELECT p.*, cs.slug, cs.biz_name, w.name AS workspace_name
        FROM programs p JOIN workspaces w ON w.id = p.workspace_id
        LEFT JOIN calendar_settings cs ON cs.workspace_id = p.workspace_id
       WHERE p.id = ${id} AND p.status = 'published'`).rows[0];
    if (!p) return notFound(res, 'This program is not available.');
    // Coach's subscription lapsed: the sales page shows the archived card.
    const access = await loadWorkspaceAccess(p.workspace_id);
    if (!access.active) return ok(res, archivedPayload(access));
    const modules = await loadModules(id, p.workspace_id);
    const items = courseOrder(modules, await loadLessons(id, p.workspace_id));
    const fin = (await sql`SELECT currency FROM finance_settings WHERE workspace_id = ${p.workspace_id}`.catch(() => ({ rows: [] }))).rows[0];
    const liveMods = new Set(modules.map((m) => m.id));
    const row = (i) => ({ id: i.id, type: i.type, title: i.title, isPreview: !!i.is_preview, moduleId: i.module_id && liveMods.has(i.module_id) ? i.module_id : null });
    return ok(res, {
      program: serializeProgram(p, { items: items.length }),
      outline: items.map(row),
      modules: modules.map((m) => ({ id: m.id, title: m.title, description: m.description || '', lessons: items.filter((i) => i.module_id === m.id).length })),
      previews: items.filter((i) => i.is_preview).map((i) => {
        // Only what a preview needs to play; never the lesson's position in a drip plan.
        const l = serializeLesson(i);
        return { id: l.id, type: l.type, title: l.title, body: l.body, fileUrl: l.fileUrl, fileName: l.fileName, youtubeId: l.youtubeId,
          videoProvider: l.videoProvider, videoEmbedUrl: l.videoEmbedUrl, mediaUrl: l.mediaUrl, mediaName: l.mediaName, images: l.images, attachments: l.attachments };
      }),
      business: { name: p.biz_name || p.workspace_name || 'Business', slug: p.slug || null },
      currency: (fin?.currency || 'USD').toUpperCase(),
      // Phase 3: what the buy box offers. Whether a trial is still open to
      // a given buyer is decided at checkout (one per person).
      trialDays: p.billing !== 'one_time' && p.trial_days ? Number(p.trial_days) : null,
      cohorts: p.delivery === 'cohort'
        ? (await openCohorts(p)).map((c) => ({ id: c.id, name: c.name, startDate: c.startDate, closesOn: c.closesOn, spotsLeft: c.spotsLeft }))
        : null,
      bundle: serializeBundle(await bundleFor(p)),
    });
  } catch (err) { return serverError(res, err); }
}
