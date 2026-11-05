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
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { withIdempotency } from '../_lib/idempotency.js';
import { fetchBranding } from '../_lib/branding.js';
import {
  fetchOwnedDoc, cloneDocument, sendDocumentForSigning, fieldProblemsForSend,
} from '../_lib/documents.js';
import { methodNotAllowed, serverError } from '../_lib/json.js';

const MAX_CLIENTS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      const raw = Array.isArray(body.clientIds) ? body.clientIds : [];
      const clientIds = [...new Set(raw.map(String).filter((x) => UUID_RE.test(x)))];
      if (clientIds.length === 0) return { status: 400, body: { error: 'Pick at least one client' } };
      if (clientIds.length > MAX_CLIENTS) return { status: 400, body: { error: `Up to ${MAX_CLIENTS} clients at a time` } };
      const ownerSigns = body.ownerSigns === 'first' || body.ownerSigns === 'last' ? body.ownerSigns : null;

      const tpl = await fetchOwnedDoc({ id: templateId, workspaceId });
      if (!tpl || !tpl.is_template) return { status: 400, body: { error: 'Template not found' } };
      const signerCount = ownerSigns ? 2 : 1;
      const problem = fieldProblemsForSend(tpl, signerCount);
      if (problem) {
        return { status: 400, body: { error: ownerSigns ? problem : `${problem} (If you sign this too, turn on "I sign it too".)` } };
      }

      let self = null;
      if (ownerSigns) {
        const email = (user.email || '').toString().toLowerCase().trim();
        if (!email) return { status: 400, body: { error: 'Your account has no email address to send your signing link to' } };
        const branding = await fetchBranding(workspaceId).catch(() => ({}));
        self = { clientId: null, name: (user.name || branding.businessName || 'Business owner').toString().slice(0, 200), email, isOwner: true };
      }

      const { rows: clients } = await sql`
        SELECT id, name, email FROM clients
         WHERE workspace_id = ${workspaceId} AND id = ANY(${clientIds}::uuid[])
      `;
      const byId = new Map(clients.map((c) => [c.id, c]));
      const branding = await fetchBranding(workspaceId).catch(() => ({}));
      const sent = [];
      const skipped = [];
      for (const cid of clientIds) {
        const c = byId.get(cid);
        if (!c) { skipped.push({ clientId: cid, name: null, reason: 'not found' }); continue; }
        const email = (c.email || '').toString().toLowerCase().trim();
        if (!email) { skipped.push({ clientId: cid, name: c.name, reason: 'no email' }); continue; }
        const client = { id: c.id, name: c.name || email, email };
        const copy = await cloneDocument({
          workspaceId, src: tpl, name: `${tpl.name} - ${client.name}`.slice(0, 200), client,
        });
        const me = { clientId: c.id, name: client.name, email };
        const recipients = ownerSigns === 'first' ? [self, me] : ownerSigns === 'last' ? [me, self] : [me];
        const r = await sendDocumentForSigning({ workspaceId, doc: copy, recipients, branding });
        sent.push({ clientId: cid, documentId: copy.id, ...(r.emailWarning ? { warning: r.emailWarning } : {}) });
      }
      return { status: 200, body: { sent, skipped } };
    }
  } catch (err) {
    return serverError(res, err);
  }
}
