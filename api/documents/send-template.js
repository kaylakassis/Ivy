// POST /api/documents/send-template
//   body: { templateId, clientIds: [uuid] (1-50), ownerSigns?: 'first' | 'last' }
//
// Sends one of your saved templates (a prepared PDF or written document)
// to many clients at once. Each client gets their own copy of the
// document (documents.template_id points back at the template) sent
// through the same sendDocumentForSigning used by the Send button, so
// links, emails, expiry and the signing chain are identical.
//
// ownerSigns adds the business as a second signer on every copy, either
// before the client ('first') or after ('last'); the template's fields
// must then be laid out for two signers.
//
// Returns { sent: [{ clientId, documentId }], skipped: [{ clientId, name, reason }] }.
// Static sibling of [id].js so Vercel routes here first.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { withIdempotency } from '../_lib/idempotency.js';
import { fetchBranding } from '../_lib/branding.js';
import { sendTemplateToClients } from '../_lib/documents.js';
import { methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const blocked = await enforce(req, res, [
      { key: `doc-send-template:ws:${workspaceId}`, max: 20, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const idemp = await withIdempotency(req, user.id, async () => doSend());
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);

    async function doSend() {
      const body = await readBody(req);
      const templateId = body.templateId ? String(body.templateId) : null;
      if (!templateId) return { status: 400, body: { error: 'templateId is required' } };
      const ownerSigns = body.ownerSigns === 'first' || body.ownerSigns === 'last' ? body.ownerSigns : null;
      let owner = null;
      if (ownerSigns) {
        const branding = await fetchBranding(workspaceId).catch(() => ({}));
        owner = { email: user.email || '', name: user.name || branding.businessName || 'Business owner' };
      }
      // Shared with Ivy's send_document_from_template (api/_lib/documents.js).
      const out = await sendTemplateToClients({
        workspaceId, templateId, clientIds: Array.isArray(body.clientIds) ? body.clientIds : [], ownerSigns, owner,
      });
      if (out.error) return { status: 400, body: { error: out.error } };
      return {
        status: 200,
        body: {
          sent: out.sent.map(({ clientId, documentId, warning }) => ({ clientId, documentId, ...(warning ? { warning } : {}) })),
          skipped: out.skipped,
        },
      };
    }
  } catch (err) {
    return serverError(res, err);
  }
}
