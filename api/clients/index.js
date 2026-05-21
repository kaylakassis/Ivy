// /api/clients
//   GET  → list current workspace's clients (optionally filtered by stage)
//   POST → create a new client / lead

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
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
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;

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

        // Bounded pagination guardrail: previously this endpoint
        // returned every client in the workspace (no LIMIT). A long-
        // tenured owner with 1K+ clients downloaded multi-MB JSON on
        // every Clients-tab visit. Now: default cap of 1000, hard
        // ceiling of 5000, plus a `hasMore` flag so a future UI can
        // wire pagination without a contract break. Existing callers
        // (current Clients.jsx, AddBookingModal etc) keep working
        // unchanged — they just see "your first 1000 clients" which
        // is fine for every workspace until the UI catches up.
        const requestedLimit = Number.parseInt(req.query.limit, 10);
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.min(5000, requestedLimit)
          : 1000;
        const requestedOffset = Number.parseInt(req.query.offset, 10);
        const offset = Number.isFinite(requestedOffset) && requestedOffset > 0
          ? requestedOffset
          : 0;
        // Fetch limit+1 so we can tell the caller whether there's
        // more without a second COUNT query.
        const probeLimit = limit + 1;

        const { stage } = req.query;
        let rows;
        if (stage && VALID_STAGES.has(stage)) {
          const r = await sql`
            SELECT * FROM clients
            WHERE workspace_id = ${workspaceId} AND stage = ${stage}
            ORDER BY COALESCE(last_seen_at, joined_at) DESC
            LIMIT ${probeLimit} OFFSET ${offset}
          `;
          rows = r.rows;
        } else {
          const r = await sql`
            SELECT * FROM clients
            WHERE workspace_id = ${workspaceId}
            ORDER BY COALESCE(last_seen_at, joined_at) DESC
            LIMIT ${probeLimit} OFFSET ${offset}
          `;
          rows = r.rows;
        }
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        return ok(res, {
          clients: page.map(serializeClient),
          hasMore,
          nextOffset: hasMore ? offset + limit : null,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[clients GET] query failed (returning empty list):', e.message);
        return ok(res, { clients: [], hasMore: false, nextOffset: null });
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
      // Email is required so the client can be invited to the portal,
      // get booking confirmations, and receive invoices.
      if (!email) return badRequest(res, 'Email is required');

      // Phone is OPTIONAL. SMS reminders / 2FA flows naturally degrade
      // to email-only when no phone is on file. A missing phone is
      // fine; a present-but-malformed phone still 400s so we don't
      // persist junk we can't dial.
      let phone = null;
      if (body.phone != null && String(body.phone).trim()) {
        phone = normalizePhone(body.phone);
        if (!phone) return badRequest(res, 'Phone number is not a valid format');
      }
      const smsConsentAt = body.smsConsent && phone ? new Date().toISOString() : null;

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
