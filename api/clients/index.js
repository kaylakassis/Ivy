// /api/clients
//   GET  → list current workspace's clients (optionally filtered by stage)
//   POST → create a new client / lead

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeClient, VALID_STAGES } from '../_lib/clients.js';
import { normalizePhone } from '../_lib/sms.js';
import { sendClientInvite } from '../_lib/clientNotify.js';
import { triggerWorkflow } from '../_lib/workflows.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      // Tolerate partial schema: a missing `clients` table or column
      // returns an empty list instead of 500ing the whole Clients tab.
      // Email lookup is exact-match — used by AddBookingModal to find
      // the matching client without making the owner pick from a list.
      try {
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
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[clients GET] query failed (returning empty list):', e.message);
        return ok(res, { clients: [] });
      }
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').toString().trim();
      const email = body.email ? body.email.toString().trim().toLowerCase() : null;
      const source = body.source ? body.source.toString().slice(0, 60) : null;
      const stage = VALID_STAGES.has(body.stage) ? body.stage : 'lead';
      const address = body.address ? body.address.toString().trim().slice(0, 500) : null;
      const photoUrl = body.photoUrl ? body.photoUrl.toString().slice(0, 1000) : null;

      if (!name) return badRequest(res, 'Name is required');
      if (name.length > 120) return badRequest(res, 'Name too long');
      // Email is now required so the client can be invited to the
      // portal, get booking confirmations, and receive invoices.
      if (!email) return badRequest(res, 'Email is required');

      // Phone now required + normalized to E.164. Bookings, SMS
      // reminders, and 2FA flows all depend on it being present and
      // dial-able.
      if (!body.phone) return badRequest(res, 'Phone number is required');
      const phone = normalizePhone(body.phone);
      if (!phone) return badRequest(res, 'Phone number is not a valid format');
      const smsConsentAt = body.smsConsent ? new Date().toISOString() : null;

      const tags = source ? [source] : [];
      const { rows } = await sql`
        INSERT INTO clients (
          workspace_id, name, email, phone, sms_consent_at, stage,
          tags, source, address, photo_url
        )
        VALUES (
          ${workspaceId}, ${name}, ${email}, ${phone}, ${smsConsentAt}, ${stage},
          ${tags}, ${source}, ${address}, ${photoUrl}
        )
        RETURNING *
      `;
      // Best-effort invite. Skip when no email or already invited.
      if (rows[0]?.email) {
        sendClientInvite({ workspaceId, clientId: rows[0].id });
      }
      // Fire workflows: client_created always; lead_created when stage='lead'.
      // Awaited so action results land before we respond — keeps the
      // "Just-now triggered" run visible in the workflow runs list when
      // the owner refreshes.
      try {
        await triggerWorkflow({
          workspaceId, triggerType: 'client_created',
          client: rows[0], context: { source: 'manual-create' },
        });
        if (rows[0].stage === 'lead') {
          await triggerWorkflow({
            workspaceId, triggerType: 'lead_created',
            client: rows[0], context: { source: 'manual-create' },
          });
        }
      } catch (wfErr) {
        // eslint-disable-next-line no-console
        console.error('[clients/create] workflow trigger failed:', wfErr.message);
      }
      return created(res, { client: serializeClient(rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
