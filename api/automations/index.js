// /api/automations - the client-facing automations Ivy sends for the
// owner (api/_lib/clientAutomations.js): the birthday message, "we'd love
// to see you again" and (1.0.6) the book-again link after a visit.
//   GET   → { automations: { birthday, quiet, rebook }, business, due? }
//           ?due=1 adds who is due (birthdays in the next 7 days, the quiet
//           clients the next run would write to, the visits that will get
//           a book-again link and when).
//   PATCH → { kind, enabled?, template?, channels?, quietDays?, delay? }
//           Saving a template approves it; turning on needs an approved
//           template (the book-again link has Ivy's fixed message, so
//           turning it on is enough). delay is rebook only: 2h,
//           next_morning or 3d. Owner only: these send to clients.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchBranding } from '../_lib/branding.js';
import { recordWorkspaceAudit } from '../_lib/audit.js';
import { readAutomations, saveAutomation, dueThisWeek, MERGE_FIELD_HELP, MAX_TEMPLATE_CHARS } from '../_lib/clientAutomations.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      const [automations, branding, svc] = await Promise.all([
        readAutomations(workspaceId), fetchBranding(workspaceId).catch(() => ({})),
        sql`SELECT name FROM services WHERE workspace_id = ${workspaceId} AND visibility <> 'only_me' ORDER BY created_at ASC LIMIT 1`.catch(() => ({ rows: [] })),
      ]);
      const out = {
        automations,
        business: branding.businessName || 'your business',
        // For the book-again preview ("Ready for your next {service}?").
        sampleService: svc.rows[0]?.name || null,
        mergeFields: MERGE_FIELD_HELP,
        maxTemplateChars: MAX_TEMPLATE_CHARS,
      };
      if (String(req.query?.due || '') === '1') out.due = await dueThisWeek(workspaceId).catch(() => null);
      return ok(res, out);
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const kind = String(body.kind || '');
      let saved;
      try { saved = await saveAutomation(workspaceId, kind, body); }
      catch (err) { return badRequest(res, err.message); }
      recordWorkspaceAudit(req, {
        workspaceId, actor: { id: user.id }, action: 'client_automation.update', target: { type: 'client_automation', id: kind },
        meta: { changed: Object.keys(saved.changed) },
      }).catch(() => {});
      return ok(res, { automation: saved.row });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
