// POST /api/me/invoices/:id/access-link
// Issues a fresh view token for an invoice tied to the authenticated user
// and returns the public URL. The existing /invoice/:token public page
// (with its "I've paid" button) handles the rest, so we don't have to
// rebuild a paid-from-portal flow.
//
// Rotating the token on every portal access invalidates the original
// emailed link - that's intentional and fine: magic links are one-shot
// anyway, and the client's authenticated session is the source of truth.
import crypto from 'node:crypto';
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { myClientIds, ids } from '../../../_lib/clientPortal.js';
import { generateRawToken, appUrl } from '../../../_lib/tokens.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const { id } = req.query;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return notFound(res, 'Invoice not found');

    // Confirm the invoice is mine before minting a token.
    const { rows } = await sql.query(
      `SELECT id FROM invoices WHERE id = $1 AND client_id = ANY($2)`,
      [id, myIds],
    );
    if (rows.length === 0) return notFound(res, 'Invoice not found');

    const raw = generateRawToken(32);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    // Defense-in-depth: re-scope the UPDATE to client_id = ANY(myIds) so a
    // future regression in the SELECT above can't be coerced into minting
    // a sign token for somebody else's invoice.
    await sql.query(
      `UPDATE invoices SET view_token_hash = $1 WHERE id = $2 AND client_id = ANY($3)`,
      [hash, id, myIds],
    );

    return ok(res, {
      url: `${appUrl()}/invoice/${encodeURIComponent(raw)}`,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
