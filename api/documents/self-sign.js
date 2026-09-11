// POST /api/documents/self-sign  body: { id }
//
// The owner added themselves as a signer and it's their turn: mint a fresh
// signing link for their own row so the editor's "Sign now" button can open
// it directly, instead of making them dig the email out of their inbox.
// Mirrors /api/me/documents/[id]/access-link for clients. Static sibling of
// [id].js so Vercel routes here first.
import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedDoc } from '../_lib/documents.js';
import { generateRawToken, appUrl } from '../_lib/tokens.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

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
    const doc = await fetchOwnedDoc({ id, workspaceId });
    if (!doc) return notFound(res, 'Document not found');
    if (doc.status !== 'sent') return badRequest(res, 'This document is not out for signature');

    const { rows } = await sql`
      SELECT id, status FROM document_signers
       WHERE document_id = ${id} AND is_owner = TRUE
       ORDER BY order_index ASC
       LIMIT 1
    `;
    const mine = rows[0];
    if (!mine) return badRequest(res, "You aren't a signer on this document");
    if (mine.status === 'completed') return badRequest(res, 'You already signed this document');
    if (mine.status === 'pending') return badRequest(res, "It's not your turn yet - the earlier signer hasn't finished");
    if (mine.status === 'declined') return badRequest(res, 'You declined this document');

    const raw = generateRawToken(32);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await sql`
      UPDATE document_signers SET sign_token_hash = ${hash}, updated_at = NOW()
       WHERE id = ${mine.id}
    `;
    // Keep the document-level pointer in step (resend/list views read it).
    await sql`UPDATE documents SET sign_token_hash = ${hash}, updated_at = NOW() WHERE id = ${id}`;
    return ok(res, { url: `${appUrl()}/sign/${encodeURIComponent(raw)}?back=documents` });
  } catch (err) {
    return serverError(res, err);
  }
}
