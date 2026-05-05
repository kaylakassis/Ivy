// /api/documents/templates
//   GET  → list all built-in starter templates (no auth body, but
//          gated by login — the gallery surfaces inside the app).
//   POST → clone a built-in template into a fresh draft for the
//          calling workspace. Body: { templateId, name? }.
//
// "Built-in" here means the static set in api/_lib/documentTemplates.js
// — distinct from user-defined templates (documents.is_template=TRUE)
// which already roundtrip through /api/documents.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeDoc } from '../_lib/documents.js';
import { listTemplatesPublic, findTemplate } from '../_lib/documentTemplates.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      return ok(res, { templates: listTemplatesPublic() });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const tplId = (body.templateId || '').toString();
      const tpl = findTemplate(tplId);
      if (!tpl) return badRequest(res, 'Unknown template');

      const name = (body.name || tpl.name).toString().trim().slice(0, 200) || tpl.name;
      const insert = await sql`
        INSERT INTO documents (workspace_id, name, kind, content_html, fields, is_template)
        VALUES (
          ${workspaceId}, ${name}, 'written',
          ${tpl.body}, ${JSON.stringify(tpl.fields)}::jsonb, FALSE
        )
        RETURNING *
      `;
      return created(res, { document: serializeDoc(insert.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
