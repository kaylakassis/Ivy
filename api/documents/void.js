// POST /api/documents/void  - body: { id }
// Marks a document voided so its sign link stops working. Owner can edit it
// again afterwards (PATCH gates on draft|voided).

import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { voidDocument, serializeDoc } from '../_lib/documents.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'id is required');

    // Shared with Ivy's void_document (api/_lib/documents.js).
    const out = await voidDocument({ workspaceId, id });
    if (out.error) return badRequest(res, out.error);
    return ok(res, { document: serializeDoc(out.row) });
  } catch (err) {
    return serverError(res, err);
  }
}
