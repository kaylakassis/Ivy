// POST /api/me/documents/:id/access-link
// Issues a fresh sign token for a document tied to the authenticated user
// and returns the public /sign/:token URL. Reuses the existing SignPage
// flow rather than re-implementing the signing UI inside the portal.
import crypto from 'node:crypto';
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { myClientIds, ids } from '../../../_lib/clientPortal.js';
import { generateRawToken, appUrl } from '../../../_lib/tokens.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { id } = req.query;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return notFound(res, 'Document not found');

    const { rows } = await sql.query(
      `SELECT id, status FROM documents
       WHERE id = $1 AND recipient_client_id = ANY($2)`,
      [id, myIds],
    );
    if (rows.length === 0) return notFound(res, 'Document not found');

    const status = rows[0].status;
    if (status === 'voided') return badRequest(res, 'This document has been voided');
    if (status === 'completed') {
      // Already signed — owners view-only-link is the same /sign route which
      // renders the post-signature state. Issue a fresh token anyway.
    }

    const raw = generateRawToken(32);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await sql`UPDATE documents SET sign_token_hash = ${hash} WHERE id = ${id}`;

    return ok(res, {
      url: `${appUrl()}/sign/${encodeURIComponent(raw)}`,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
