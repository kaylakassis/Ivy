// POST /api/documents/void  — body: { id }
// Marks a document voided so its sign link stops working. Owner can edit it
// again afterwards (PATCH gates on draft|voided).

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedDoc, serializeDoc } from '../_lib/documents.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'id is required');

    const doc = await fetchOwnedDoc({ id, workspaceId });
    if (!doc) return badRequest(res, 'Document not found');
    if (doc.status === 'completed') return badRequest(res, "Can't void a completed document");

    const newActivity = [
      ...(doc.activity || []),
      { ts: new Date().toISOString(), kind: 'voided', text: 'Document voided' },
    ];

    // Kill every outstanding sign link, not just the legacy single-
    // signer one on the documents row. Multi-signer flows mint a
    // separate token per signer in document_signers; without this
    // second UPDATE, signers 2..N could still complete a voided doc
    // (legal/compliance problem).
    const updated = await sql`
      UPDATE documents SET
        status = 'voided',
        sign_token_hash = NULL,
        activity = ${JSON.stringify(newActivity)}::jsonb,
        updated_at = NOW()
      WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;
    // Guard against a race where the doc was deleted between fetch
    // and update — without this we'd hand the serializer `undefined`
    // and respond `{ document: null }` masking the real failure.
    if (updated.rows.length === 0) {
      return badRequest(res, 'Document not found — was it deleted while you were voiding it?');
    }
    try {
      // Nulling the token is enough — sign/[token] resolves by hash
      // and will 404 with no token to match. Status stays 'awaiting'
      // (the CHECK constraint doesn't allow 'voided' on this table).
      await sql`
        UPDATE document_signers SET
          sign_token_hash = NULL,
          updated_at = NOW()
        WHERE document_id = ${id}
      `;
    } catch (e) {
      // document_signers may not exist on older deploys — log + continue.
      console.error('[documents/void] document_signers cleanup failed:', e.message);
    }
    return ok(res, { document: serializeDoc(updated.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}
