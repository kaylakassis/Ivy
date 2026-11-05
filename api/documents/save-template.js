// POST /api/documents/save-template  body: { id, name? }
//
// "Save as template": copies a document you prepared (an uploaded PDF
// with its fields placed, or a written document) into a reusable
// template. The original document is left exactly as it was. Field
// values are blanked; the PDF file itself is shared, never copied.
//
// Static sibling of [id].js so Vercel routes here first.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { fetchOwnedDoc, serializeDoc, cloneDocument } from '../_lib/documents.js';
import { badRequest, created, methodNotAllowed, notFound, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const blocked = await enforce(req, res, [
      { key: `doc-save-template:ws:${workspaceId}`, max: 60, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return badRequest(res, 'id is required');
    const doc = await fetchOwnedDoc({ id, workspaceId });
    if (!doc) return notFound(res, 'Document not found');
    if (doc.kind === 'pdf' && !doc.file_url) return badRequest(res, 'Upload the PDF first');
    const name = (body.name == null ? doc.name : String(body.name)).trim().slice(0, 200);
    if (!name) return badRequest(res, 'Name is required');

    const tpl = await cloneDocument({ workspaceId, src: doc, name, asTemplate: true });
    return created(res, { template: serializeDoc(tpl) });
  } catch (err) {
    return serverError(res, err);
  }
}
