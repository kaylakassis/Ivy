// POST /api/documents/resend  body: { id }
//
// Re-emails the current pending signer of a document. Mints a fresh
// sign token (invalidates the prior link), updates the signer row
// (and the legacy documents.sign_token_hash mirror), and appends an
// activity entry.
//
// Refuses if the document is completed, voided, or has no pending
// signer (e.g. already declined). For multi-signer flows, only the
// CURRENT awaiting signer gets the resend - subsequent signers
// receive their links automatically when their turn comes up.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { resendDocument, serializeDoc } from '../_lib/documents.js';
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
    // Idempotent wrap - a Resend retry used to mint a fresh token
    // every time (invalidating the prior link sent moments earlier),
    // so a double-click would race itself.
    const idemp = await withIdempotency(req, user.id, async () => doResend());
    if (idemp.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.status(idemp.status).json(idemp.body);

    async function doResend() {
    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    if (!id) return { status: 400, body: { error: 'id is required' } };

    // Shared with Ivy's resend_document (api/_lib/documents.js).
    const out = await resendDocument({ workspaceId, id });
    if (out.error) return { status: 400, body: { error: out.error } };
    return {
      status: 200,
      body: {
        document: serializeDoc(out.row),
        ...(out.emailWarning ? { warning: out.emailWarning } : {}),
      },
    };
    } // end doResend
  } catch (err) {
    return serverError(res, err);
  }
}
