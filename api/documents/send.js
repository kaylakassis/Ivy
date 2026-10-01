// POST /api/documents/send  body: { id, recipients }
//   recipients: [{ clientId, name?, email? }, ...]   - multi-signer.
//                For backward compat with single-signer callers, also
//                accepts a single { clientId } shape.
//
// Resolves the recipients, then hands off to sendDocumentForSigning
// (api/_lib/documents.js) which builds a document_signers row per
// recipient (in order), mints a token for the FIRST signer only
// (sequential signing), emails them, and drops a system message in the
// chat thread for that first client.
// When that signer completes, /api/sign/[token] mints + emails the
// next signer's token, and so on. The final completion stamps the
// document and computes the tamper-evident hash.
//
// File lives next to /api/documents/[id].js as a static sibling so
// Vercel's router sends `/api/documents/send` to this file instead of
// the dynamic [id] handler.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedDoc, serializeDoc, sendDocumentForSigning } from '../_lib/documents.js';
import { fetchBranding } from '../_lib/branding.js';
import { withIdempotency } from '../_lib/idempotency.js';
import { methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    // Idempotent wrap - sending the same multi-signer document twice
    // would DELETE + INSERT new signer rows (with new tokens), invalidating
    // the in-flight link the first signer just received. With the
    // Idempotency-Key header, retries collapse to the cached response.
    const idemp = await withIdempotency(req, user.id, async () => doSend());
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);

    async function doSend() {
    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return { status: 400, body: { error: 'id is required' } };

    // Normalize input: accept either a `recipients` array OR a legacy
    // single-clientId shape. Cap at 10 signers to keep the UI sane.
    let recipients = [];
    if (Array.isArray(body.recipients) && body.recipients.length > 0) {
      recipients = body.recipients;
    } else if (body.clientId) {
      recipients = [{ clientId: body.clientId }];
    } else {
      return { status: 400, body: { error: 'recipients or clientId is required' } };
    }
    if (recipients.length > 10) return { status: 400, body: { error: 'Up to 10 signers per document' } };

    const doc = await fetchOwnedDoc({ id, workspaceId });
    if (!doc) return { status: 400, body: { error: 'Document not found' } };
    if (doc.status === 'completed') return { status: 400, body: { error: 'Already completed' } };
    if (doc.status === 'voided')    return { status: 400, body: { error: 'Document is voided - restore first' } };
    if (doc.status === 'declined')  return { status: 400, body: { error: 'Document was declined - restore to draft first' } };

    // Resolve each recipient: must belong to this workspace, must have an
    // email. Build the rows we'll insert.
    const resolved = [];
    for (const r of recipients) {
      // { self: true } - the owner signs too (countersigning an agreement,
      // or a template with a "Coach signature" line). No client row; the
      // email is the account email.
      if (r.self) {
        const email = (user.email || '').toString().toLowerCase().trim();
        if (!email) return { status: 400, body: { error: 'Your account has no email address to send your signing link to' } };
        if (resolved.some((x) => x.isOwner)) return { status: 400, body: { error: 'You can only be added as a signer once' } };
        const branding = await fetchBranding(workspaceId);
        const name = (r.name || user.name || branding.businessName || 'Business owner').toString().slice(0, 200);
        resolved.push({ clientId: null, name, email, isOwner: true });
        continue;
      }
      const cid = r.clientId ? String(r.clientId) : null;
      if (!cid) return { status: 400, body: { error: 'Each recipient needs a clientId' } };
      const cl = await sql`
        SELECT id, name, email FROM clients
        WHERE id = ${cid} AND workspace_id = ${workspaceId}
      `;
      if (cl.rows.length === 0) return { status: 400, body: { error: `Unknown client: ${cid}` } };
      const c = cl.rows[0];
      const name = (r.name || c.name || '').toString().slice(0, 200);
      const email = (r.email || c.email || '').toString().toLowerCase().trim();
      if (!email) return { status: 400, body: { error: `Client ${name || cid} has no email` } };
      resolved.push({ clientId: cid, name, email });
    }

    // Signer rows + token + 'sent' flip + email + thread message all live
    // in the shared sendDocumentForSigning (api/_lib/documents.js) so the
    // workflow action "Send a document for signing" does exactly what
    // this button does.
    const { row: updatedRow, signers, link, emailWarning } = await sendDocumentForSigning({
      workspaceId, doc, recipients: resolved,
    });
    const first = resolved[0];

    return {
      status: 200,
      body: {
        document: serializeDoc(updatedRow, signers),
        // When the owner is up first they can sign right away - no need
        // to go find the email.
        ...(first.isOwner ? { selfSignUrl: link } : {}),
        ...(emailWarning ? { warning: emailWarning } : {}),
      },
    };
    } // end doSend
  } catch (err) {
    return serverError(res, err);
  }
}
