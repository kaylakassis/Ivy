// GET /api/me/documents — list every document where the user is the
// recipient, across businesses they're a client of.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { myClientIds, ids } from '../../_lib/clientPortal.js';
import { methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const memberships = await myClientIds(user);
    const myIds = ids(memberships);
    if (myIds.length === 0) return ok(res, { documents: [] });

    const byClient = new Map(memberships.map((m) => [m.clientId, m]));

    // Surface documents where the user is EITHER the legacy recipient
    // OR a signer in the multi-signer flow. The DISTINCT + UNION
    // handles the overlap (a multi-signer doc has the active recipient
    // in BOTH columns at any given moment).
    let rows;
    try { ({ rows } = await sql.query(
      `SELECT DISTINCT ON (d.id)
              d.id, d.recipient_client_id, d.name, d.kind, d.status,
              d.sent_at, d.completed_at, d.updated_at, d.declined_at,
              d.decline_reason, d.final_pdf_url, d.completion_hash,
              jsonb_array_length(d.fields) AS field_count,
              d.page_count
         FROM documents d
        WHERE d.status <> 'draft'
          AND (
            d.recipient_client_id = ANY($1)
            OR EXISTS (
              SELECT 1 FROM document_signers ds
               WHERE ds.document_id = d.id
                 AND ds.client_id = ANY($1)
            )
          )
        ORDER BY d.id, d.updated_at DESC
        LIMIT 500`,
      [myIds],
    )); } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[me/documents] main query failed (returning empty):', e.message);
      return ok(res, { documents: [] });
    }

    // Pull every signer for the docs we just listed, scoped to the
    // user's own client_ids so we only show THEIR signing status —
    // not other signers' names, emails, IPs, etc.
    const docIds = rows.map((r) => r.id);
    const signerByDoc = new Map();
    let totalsByDoc = new Map();
    if (docIds.length > 0) {
      try {
        const sr = await sql.query(
          `SELECT document_id, client_id, status, signed_at, declined_at, order_index
             FROM document_signers
            WHERE document_id = ANY($1::uuid[])
              AND client_id = ANY($2)`,
          [docIds, myIds],
        );
        for (const row of sr.rows) {
          signerByDoc.set(row.document_id, row);
        }
        // Total signer count per doc, used for "You're signer X of Y" copy.
        const tr = await sql.query(
          `SELECT document_id, COUNT(*)::int AS total
             FROM document_signers
            WHERE document_id = ANY($1::uuid[])
            GROUP BY document_id`,
          [docIds],
        );
        totalsByDoc = new Map(tr.rows.map((r) => [r.document_id, r.total]));
      } catch (e) {
        // document_signers table missing — fall back to no per-signer
        // detail, but still render the documents list.
        // eslint-disable-next-line no-console
        console.error('[me/documents] signers join failed (continuing):', e.message);
      }
    }

    // Re-sort by updated_at since DISTINCT ON forces ordering by id first.
    rows.sort((a, b) => (b.updated_at?.getTime?.() || 0) - (a.updated_at?.getTime?.() || 0));

    const documents = rows.map((r) => {
      const m = byClient.get(r.recipient_client_id);
      const mySigner = signerByDoc.get(r.id);
      const totalSigners = totalsByDoc.get(r.id) || 0;
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        status: r.status,
        sentAt: r.sent_at,
        completedAt: r.completed_at,
        declinedAt: r.declined_at,
        declineReason: r.decline_reason,
        updatedAt: r.updated_at,
        fieldCount: r.field_count || 0,
        pageCount: r.page_count || 1,
        // For multi-signer docs that have completed, surface the URL
        // of the final flattened PDF so the client can download their
        // copy. Single-signer / written docs leave this null.
        finalPdfUrl: r.final_pdf_url || null,
        completionHash: r.completion_hash || null,
        businessName: m?.businessName || 'Business',
        // Per-user signer view: where THIS signer stands in the chain,
        // not other signers' personal info.
        mySigner: mySigner ? {
          status:     mySigner.status,
          signedAt:   mySigner.signed_at || null,
          declinedAt: mySigner.declined_at || null,
          orderIndex: mySigner.order_index,
        } : null,
        totalSigners,
      };
    });
    return ok(res, { documents });
  } catch (err) {
    return serverError(res, err);
  }
}
