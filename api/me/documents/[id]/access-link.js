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

    // Look up the document AND verify the user has standing to access
    // it - either as the legacy recipient OR as a multi-signer.
    const docRows = await sql.query(
      `SELECT id, status, final_pdf_url FROM documents
        WHERE id = $1
          AND (
            recipient_client_id = ANY($2)
            OR EXISTS (
              SELECT 1 FROM document_signers ds
               WHERE ds.document_id = documents.id
                 AND ds.client_id = ANY($2)
            )
          )`,
      [id, myIds],
    );
    if (docRows.rows.length === 0) return notFound(res, 'Document not found');
    const status = docRows.rows[0].status;
    if (status === 'voided')   return badRequest(res, 'This document has been voided');
    if (status === 'declined') return badRequest(res, 'This document was declined');
    // Completed docs: there's nothing left to sign and resolveByToken rejects
    // a sign token for a non-'sent' doc (→ a dead "view signed copy" link).
    // Return the flattened signed PDF for viewing instead of minting a token.
    if (status === 'completed') {
      const finalUrl = docRows.rows[0].final_pdf_url;
      if (finalUrl) return ok(res, { url: finalUrl, completed: true });
      return badRequest(res, 'This document is complete — the signed copy is still being prepared.');
    }

    // Find the user's signer row, if any. Used to:
    //   • For multi-signer docs: mint the token onto THEIR signer row
    //     so resolveByToken in /api/sign/[token] takes the multi-signer
    //     path. Minting on documents.sign_token_hash would let them
    //     sign-the-whole-thing via the legacy fallback, bypassing the
    //     order-of-signers chain - a subtle multi-tenant safety break.
    //   • Refuse if it's not their turn (status='pending').
    const signerRows = await sql.query(
      `SELECT id, status, order_index FROM document_signers
        WHERE document_id = $1 AND client_id = ANY($2)
        LIMIT 1`,
      [id, myIds],
    );
    const mySigner = signerRows.rows[0] || null;

    const raw = generateRawToken(32);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    if (mySigner) {
      if (mySigner.status === 'pending') {
        return badRequest(res, "It's not your turn yet - you'll be emailed when the previous signer is done.");
      }
      // 'awaiting' / 'viewed' / 'completed' / 'declined' - mint a fresh
      // token onto the signer row. resolveByToken handles whether they
      // can still sign or just view based on doc + signer status.
      await sql.query(
        `UPDATE document_signers SET sign_token_hash = $1, updated_at = NOW()
          WHERE id = $2 AND client_id = ANY($3)`,
        [hash, mySigner.id, myIds],
      );
      return ok(res, { url: `${appUrl()}/sign/${encodeURIComponent(raw)}` });
    }

    // Legacy single-signer flow - no document_signers row. Defense-in-
    // depth: re-scope the UPDATE to recipient_client_id = ANY(myIds).
    await sql.query(
      `UPDATE documents SET sign_token_hash = $1 WHERE id = $2 AND recipient_client_id = ANY($3)`,
      [hash, id, myIds],
    );

    return ok(res, {
      url: `${appUrl()}/sign/${encodeURIComponent(raw)}`,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
