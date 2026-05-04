// /api/clients
//   GET  → list current workspace's clients (optionally filtered by stage)
//   POST → create a new client / lead

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeClient, VALID_STAGES } from '../_lib/clients.js';
import { normalizePhone } from '../_lib/sms.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      // Email lookup is exact-match — used by AddBookingModal to find
      // the matching client without making the owner pick from a list.
      // Returns at most one client (workspace_id + email is effectively
      // unique given the public booking flow's upsert).
      const email = (req.query.email || '').toString().trim().toLowerCase();
      if (email) {
        const r = await sql`
          SELECT * FROM clients
          WHERE workspace_id = ${workspaceId} AND email = ${email}
          LIMIT 1
        `;
        return ok(res, { clients: r.rows.map(serializeClient) });
      }
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

      // Optional phone — normalized to E.164 or rejected outright if
      // malformed so we never store junk that breaks Twilio later.
      let phone = null;
      if (body.phone) {
        phone = normalizePhone(body.phone);
        if (!phone) return badRequest(res, 'Phone number is not a valid format');
      }
      const smsConsentAt = body.smsConsent ? new Date().toISOString() : null;

      const tags = source ? [source] : [];
      const { rows } = await sql`
        INSERT INTO clients (workspace_id, name, email, phone, sms_consent_at, stage, tags, source)
        VALUES (${workspaceId}, ${name}, ${email}, ${phone}, ${smsConsentAt}, ${stage}, ${tags}, ${source})
        RETURNING *
      `;
      return created(res, { client: serializeClient(rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
