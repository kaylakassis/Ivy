// /api/time-entries
//   GET  → list entries (?status=running|stopped|billed, ?clientId=)
//   POST → start a new entry. Stops any currently running entry first
//          so the workspace only has one active timer at a time.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  serializeEntry, listEntries, VALID_STATUS,
} from '../_lib/timeEntries.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const status = (req.query.status || '').toString();
      const clientId = (req.query.clientId || '').toString() || null;
      const filtered = VALID_STATUS.has(status) ? status : null;
      const entries = await listEntries({ workspaceId, status: filtered, clientId });
      // Surface the workspace's default hourly rate so the timer UI
      // can pre-fill it without an extra round trip.
      const fs = await sql`
        SELECT default_hourly_rate FROM finance_settings WHERE workspace_id = ${workspaceId}
      `;
      const defaultHourlyRate = Number(fs.rows[0]?.default_hourly_rate || 0);
      return ok(res, { entries, defaultHourlyRate });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const description = (body.description || '').toString().slice(0, 1000) || null;
      const clientId    = body.clientId  ? String(body.clientId)  : null;
      const serviceId   = body.serviceId ? String(body.serviceId) : null;
      const billable    = body.billable !== false;
      let hourlyRate    = Number(body.hourlyRate);
      if (!Number.isFinite(hourlyRate) || hourlyRate < 0) hourlyRate = 0;

      // Validate client / service ownership.
      if (clientId) {
        const c = await sql`SELECT id FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
        if (c.rows.length === 0) return badRequest(res, 'Unknown client');
      }
      if (serviceId) {
        const s = await sql`SELECT id, price, duration_minutes FROM services WHERE id = ${serviceId} AND workspace_id = ${workspaceId}`;
        if (s.rows.length === 0) return badRequest(res, 'Unknown service');
      }

      // Stop the current running entry, if any, so we only have one
      // active timer per workspace. Keeps the UI a single button.
      await sql`
        UPDATE time_entries SET
          ended_at         = NOW(),
          duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int),
          status           = 'stopped',
          updated_at       = NOW()
        WHERE workspace_id = ${workspaceId} AND status = 'running'
      `;

      // If no rate provided, fall back to the workspace default.
      if (!hourlyRate) {
        const fs = await sql`SELECT default_hourly_rate FROM finance_settings WHERE workspace_id = ${workspaceId}`;
        hourlyRate = Number(fs.rows[0]?.default_hourly_rate || 0);
      }

      const insert = await sql`
        INSERT INTO time_entries (
          workspace_id, client_id, service_id, description,
          hourly_rate, billable, status
        ) VALUES (
          ${workspaceId}, ${clientId}, ${serviceId}, ${description},
          ${hourlyRate}, ${billable}, 'running'
        )
        RETURNING *
      `;
      // Re-fetch with joins for serialization.
      const r = await sql`
        SELECT t.*, c.name AS client_name, s.name AS service_name
          FROM time_entries t
          LEFT JOIN clients c  ON c.id = t.client_id
          LEFT JOIN services s ON s.id = t.service_id
         WHERE t.id = ${insert.rows[0].id}
      `;
      return created(res, { entry: serializeEntry(r.rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
