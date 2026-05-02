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

    const { rows } = await sql.query(
      `SELECT id, recipient_client_id, name, kind, status,
              sent_at, completed_at, updated_at
       FROM documents
       WHERE recipient_client_id = ANY($1)
         AND status <> 'draft'
       ORDER BY updated_at DESC
       LIMIT 500`,
      [myIds],
    );

    const documents = rows.map((r) => {
      const m = byClient.get(r.recipient_client_id);
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        status: r.status,
        sentAt: r.sent_at,
        completedAt: r.completed_at,
        updatedAt: r.updated_at,
        businessName: m?.businessName || 'Business',
      };
    });
    return ok(res, { documents });
  } catch (err) {
    return serverError(res, err);
  }
}
