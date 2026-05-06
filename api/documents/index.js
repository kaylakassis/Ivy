// /api/documents
//   GET  → list documents for current workspace
//   POST → create a new document (draft)

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeDoc, cleanFields, fetchSignersBulk, VALID_KINDS, VALID_STATUS } from '../_lib/documents.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const status = req.query.status;
      // ?templates=1 returns only is_template=TRUE rows; ?templates=0
      // (or absent) returns instances. ServicesDrawer's intake picker
      // calls with templates=1.
      const templatesOnly = req.query.templates === '1';
      let rows;
      if (templatesOnly) {
        const r = await sql`
          SELECT * FROM documents
          WHERE workspace_id = ${workspaceId} AND is_template = TRUE
          ORDER BY name ASC
        `;
        rows = r.rows;
      } else if (status && VALID_STATUS.has(status)) {
        const r = await sql`
          SELECT * FROM documents
          WHERE workspace_id = ${workspaceId} AND status = ${status}
            AND is_template = FALSE
          ORDER BY updated_at DESC
        `;
        rows = r.rows;
      } else {
        const r = await sql`
          SELECT * FROM documents
          WHERE workspace_id = ${workspaceId} AND is_template = FALSE
          ORDER BY updated_at DESC
        `;
        rows = r.rows;
      }
      // Bulk-fetch signers in one round trip so each row can show its
      // multi-signer progress without N+1 queries.
      const signersByDoc = await fetchSignersBulk(rows.map((r) => r.id));
      return ok(res, {
        documents: rows.map((r) => serializeDoc(r, signersByDoc.get(r.id) || [])),
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').toString().trim();
      const kind = body.kind || 'written';
      // Accept empty string on create — the new UX is "name the doc,
      // then write the body in the editor that opens." Truncate at
      // 200k for written docs; pass through null/empty for upload-kind
      // docs that don't have HTML at all.
      const rawHtml = body.contentHtml == null ? '' : String(body.contentHtml);
      const contentHtml = rawHtml.slice(0, 200000);
      const fields = cleanFields(body.fields ?? []);

      if (!name) return badRequest(res, 'Name is required');
      if (name.length > 200) return badRequest(res, 'Name too long');
      if (!VALID_KINDS.has(kind)) return badRequest(res, 'Invalid kind');
      if (fields === null) return badRequest(res, 'Invalid fields');

      const isTemplate = !!body.isTemplate;
      const insert = await sql`
        INSERT INTO documents (workspace_id, name, kind, content_html, fields, is_template)
        VALUES (${workspaceId}, ${name}, ${kind}, ${contentHtml}, ${JSON.stringify(fields)}::jsonb, ${isTemplate})
        RETURNING *
      `;
      return created(res, { document: serializeDoc(insert.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
