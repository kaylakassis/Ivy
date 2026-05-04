// /api/documents/:id
//   GET    → single document (workspace-scoped)
//   PATCH  → update draft fields (only allowed while status='draft')
//   DELETE → remove

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedDoc, serializeDoc, cleanFields } from '../_lib/documents.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    const { id } = req.query;

    const doc = await fetchOwnedDoc({ id, workspaceId });
    if (!doc) return notFound(res, 'Document not found');

    if (req.method === 'GET') {
      return ok(res, { document: serializeDoc(doc) });
    }

    if (req.method === 'PATCH') {
      // Only drafts and voided are editable; once sent we lock the content.
      if (doc.status !== 'draft' && doc.status !== 'voided') {
        return badRequest(res, "Can't edit a document after it's been sent");
      }

      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('name' in body) {
        const v = (body.name || '').toString().trim();
        if (!v || v.length > 200) return badRequest(res, 'Name is required (max 200 chars)');
        push('name', v);
      }
      if ('contentHtml' in body) {
        push('content_html', body.contentHtml ? String(body.contentHtml).slice(0, 200000) : null);
      }
      if ('fields' in body) {
        const fields = cleanFields(body.fields);
        if (fields === null) return badRequest(res, 'Invalid fields');
        push('fields', JSON.stringify(fields));
      }
      if ('isTemplate' in body) {
        push('is_template', !!body.isTemplate);
      }

      if (sets.length === 0) return ok(res, { document: serializeDoc(doc) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE documents SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { document: serializeDoc(rows[0]) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM documents WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
