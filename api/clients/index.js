// /api/clients
//   GET  → list current workspace's clients (optionally filtered by stage)
//   POST → create a new client / lead

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { serializeClient, VALID_STAGES } from '../_lib/clients.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const { stage } = req.query;
      let rows;
      if (stage && VALID_STAGES.has(stage)) {
        const r = await sql`
          SELECT * FROM clients
          WHERE workspace_id = ${workspaceId} AND stage = ${stage}
          ORDER BY COALESCE(last_seen_at, joined_at) DESC
        `;
        rows = r.rows;
      } else {
        const r = await sql`
          SELECT * FROM clients
          WHERE workspace_id = ${workspaceId}
          ORDER BY COALESCE(last_seen_at, joined_at) DESC
        `;
        rows = r.rows;
      }
      return ok(res, { clients: rows.map(serializeClient) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').toString().trim();
      const email = body.email ? body.email.toString().trim().toLowerCase() : null;
      const source = body.source ? body.source.toString().slice(0, 60) : null;
      const stage = VALID_STAGES.has(body.stage) ? body.stage : 'lead';

      if (!name) return badRequest(res, 'Name is required');
      if (name.length > 120) return badRequest(res, 'Name too long');

      const tags = source ? [source] : [];
      const { rows } = await sql`
        INSERT INTO clients (workspace_id, name, email, stage, tags, source)
        VALUES (${workspaceId}, ${name}, ${email}, ${stage}, ${tags}, ${source})
        RETURNING *
      `;
      return created(res, { client: serializeClient(rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
