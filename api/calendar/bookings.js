// POST /api/calendar/bookings — owner-side booking creation.
// Same validation as the public booking flow (slot must be in availability,
// no conflicts, etc.) but lets the owner specify recurrence and an existing
// client_id (instead of always creating a lead).

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace, validEmail } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import {
  hasConflict, withinAvailability, serializeBooking, VALID_RECURRENCE,
} from '../_lib/calendar.js';
import { notifyNewBooking } from '../_lib/bookingNotify.js';
import { syncOnBookingCreated } from '../_lib/googleSync.js';
import { consumeCredit } from '../_lib/packages.js';
import { badRequest, created, methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    const date  = (body.date || '').toString();
    const start = Number(body.startMin);
    const end   = Number(body.endMin);
    const serviceId = body.serviceId ? String(body.serviceId) : null;
    const clientId  = body.clientId  ? String(body.clientId)  : null;
    const clientName  = (body.clientName  || '').toString().trim().slice(0, 120);
    const clientEmail = (body.clientEmail || '').toString().trim().toLowerCase();
    const notes = body.notes ? String(body.notes).slice(0, 4000) : null;
    const recurrenceRule  = body.recurrenceRule  ? String(body.recurrenceRule)  : null;
    const recurrenceUntil = body.recurrenceUntil ? String(body.recurrenceUntil) : null;
    const skipConflictCheck = !!body.skipConflictCheck;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'date must be YYYY-MM-DD');
    if (!Number.isInteger(start) || start < 0 || start >= 24 * 60) return badRequest(res, 'invalid startMin');
    if (!Number.isInteger(end) || end <= start || end > 24 * 60) return badRequest(res, 'invalid endMin');
    if (!clientName) return badRequest(res, "Client's name is required");
    if (!validEmail(clientEmail)) return badRequest(res, 'A valid email is required');
    if (!VALID_RECURRENCE.has(recurrenceRule)) return badRequest(res, 'Invalid recurrence rule');
    if (recurrenceUntil && !/^\d{4}-\d{2}-\d{2}$/.test(recurrenceUntil)) return badRequest(res, 'recurrenceUntil must be YYYY-MM-DD');

    // Validate service if provided.
    if (serviceId) {
      const r = await sql`SELECT id FROM services WHERE id = ${serviceId} AND workspace_id = ${workspaceId}`;
      if (r.rows.length === 0) return badRequest(res, 'Unknown service');
    }
    // Validate client if provided.
    let resolvedClientId = clientId;
    if (clientId) {
      const r = await sql`SELECT id FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}`;
      if (r.rows.length === 0) return badRequest(res, 'Unknown client');
    } else {
      // Try to attach by email; create a lead if missing.
      const existing = await sql`
        SELECT id FROM clients WHERE workspace_id = ${workspaceId} AND email = ${clientEmail} LIMIT 1
      `;
      if (existing.rows.length > 0) {
        resolvedClientId = existing.rows[0].id;
      } else {
        const newClient = await sql`
          INSERT INTO clients (workspace_id, name, email, stage, source)
          VALUES (${workspaceId}, ${clientName}, ${clientEmail}, 'active', 'Direct booking')
          RETURNING id
        `;
        resolvedClientId = newClient.rows[0].id;
      }
    }

    // Conflict check (owner can override with skipConflictCheck=true to handle
    // edge cases like double-booking by request).
    if (!skipConflictCheck) {
      const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
      const settings = await sql`SELECT availability FROM calendar_settings WHERE workspace_id = ${workspaceId}`;
      if (settings.rows.length > 0 && !withinAvailability(settings.rows[0].availability, weekday, start, end)) {
        return badRequest(res, 'That slot is outside your availability — toggle Override to book anyway');
      }
      if (await hasConflict({ workspaceId, dateISO: date, start, end })) {
        return badRequest(res, 'That slot conflicts with an existing booking or block');
      }
    }

    // Optional package credit consumption. The atomic decrement in
    // consumeCredit prevents two concurrent bookings from spending the
    // same last credit. We refuse the booking outright if the consume
    // fails — easier UX than silently falling back to "pay normally"
    // when the owner explicitly chose a package.
    const clientPackageId = body.clientPackageId ? String(body.clientPackageId) : null;
    if (clientPackageId) {
      if (!resolvedClientId) {
        return badRequest(res, 'Package bookings require a client');
      }
      const ok = await consumeCredit({
        workspaceId,
        clientPackageId,
        clientId: resolvedClientId,
        serviceId,
      });
      if (!ok) return badRequest(res, 'Package has no credits left, is expired, or doesn\'t cover this service');
    }

    const insert = await sql`
      INSERT INTO bookings (
        workspace_id, service_id, client_id, client_name, client_email,
        date, start_min, end_min, notes, recurrence_rule, recurrence_until,
        client_package_id
      )
      VALUES (
        ${workspaceId}, ${serviceId}, ${resolvedClientId}, ${clientName}, ${clientEmail},
        ${date}, ${start}, ${end}, ${notes}, ${recurrenceRule}, ${recurrenceUntil},
        ${clientPackageId}
      )
      RETURNING *
    `;
    // Auto-create the client-side chat thread + send the client a confirmation.
    // Don't notify the owner here (they're the one who just created it).
    notifyNewBooking({ workspaceId, bookingId: insert.rows[0].id, source: 'owner' });
    // Best-effort Google Calendar push. Failures log + skip; never block.
    syncOnBookingCreated({ workspaceId, bookingId: insert.rows[0].id });
    return created(res, { booking: serializeBooking(insert.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}
