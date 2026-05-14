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
import { notifyPackageExhausted } from '../_lib/packageNotify.js';
import { syncOnBookingCreated } from '../_lib/googleSync.js';
import { consumeCredit } from '../_lib/packages.js';
import { attachIntakeForms } from '../_lib/intake.js';
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
    const staffId = body.staffId ? String(body.staffId) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'date must be YYYY-MM-DD');
    if (!Number.isInteger(start) || start < 0 || start >= 24 * 60) return badRequest(res, 'invalid startMin');
    if (!Number.isInteger(end) || end <= start || end > 24 * 60) return badRequest(res, 'invalid endMin');
    if (!clientName) return badRequest(res, "Client's name is required");
    if (!validEmail(clientEmail)) return badRequest(res, 'A valid email is required');
    if (!VALID_RECURRENCE.has(recurrenceRule)) return badRequest(res, 'Invalid recurrence rule');
    if (recurrenceUntil && !/^\d{4}-\d{2}-\d{2}$/.test(recurrenceUntil)) return badRequest(res, 'recurrenceUntil must be YYYY-MM-DD');

    // Validate service if provided + capture capacity for the slot
    // conflict check (group services let multiple bookings share a slot).
    let serviceCapacity = 1;
    if (serviceId) {
      const r = await sql`SELECT id, capacity FROM services WHERE id = ${serviceId} AND workspace_id = ${workspaceId}`;
      if (r.rows.length === 0) return badRequest(res, 'Unknown service');
      serviceCapacity = Math.max(1, Number(r.rows[0].capacity) || 1);
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
      if (await hasConflict({ workspaceId, dateISO: date, start, end, serviceId, capacity: serviceCapacity })) {
        return badRequest(res, serviceCapacity > 1
          ? 'That class is full or the slot conflicts with another booking'
          : 'That slot conflicts with an existing booking or block');
      }
    }

    // Optional package credit consumption. The atomic decrement in
    // consumeCredit prevents two concurrent bookings from spending the
    // same last credit. We refuse the booking outright if the consume
    // fails — easier UX than silently falling back to "pay normally"
    // when the owner explicitly chose a package.
    const clientPackageId = body.clientPackageId ? String(body.clientPackageId) : null;
    let packageExhaustionEvent = null;
    if (clientPackageId) {
      if (!resolvedClientId) {
        return badRequest(res, 'Package bookings require a client');
      }
      const consumeResult = await consumeCredit({
        workspaceId,
        clientPackageId,
        clientId: resolvedClientId,
        serviceId,
      });
      if (!consumeResult.ok) {
        return badRequest(res, 'Package has no credits left, is expired, or doesn\'t cover this service');
      }
      // Stash the exhaustion signal — fired AFTER the booking row is
      // inserted so the owner notification reflects the final state.
      if (consumeResult.exhausted) {
        packageExhaustionEvent = { clientPackageId, clientId: resolvedClientId };
      }
    }

    // Verify staff (if supplied) belongs to this workspace + is active.
    // Defense-in-depth — never trust the browser-sent staff id alone.
    if (staffId) {
      try {
        const st = await sql`
          SELECT id FROM staff_members
           WHERE id = ${staffId} AND workspace_id = ${workspaceId} AND active = TRUE
        `;
        if (st.rows.length === 0) return badRequest(res, 'Unknown or inactive staff member');
      } catch (e) {
        // staff_members table not yet created (partial schema) — drop
        // the assignment quietly so the booking still saves.
        // eslint-disable-next-line no-console
        console.error('[bookings] staff_members lookup failed; ignoring staffId:', e.message);
      }
    }

    // Insert. If `staff_id` column hasn't migrated yet, self-heal by
    // adding it and retrying once — same pattern as
    // api/onboarding/state.js. Belt + suspenders for partial-schema
    // cold starts.
    let insert;
    const doInsert = () => sql`
      INSERT INTO bookings (
        workspace_id, service_id, client_id, client_name, client_email,
        date, start_min, end_min, notes, recurrence_rule, recurrence_until,
        client_package_id, staff_id
      )
      VALUES (
        ${workspaceId}, ${serviceId}, ${resolvedClientId}, ${clientName}, ${clientEmail},
        ${date}, ${start}, ${end}, ${notes}, ${recurrenceRule}, ${recurrenceUntil},
        ${clientPackageId}, ${staffId}
      )
      RETURNING *
    `;
    try {
      insert = await doInsert();
    } catch (e) {
      if (/staff_id.*does not exist|column .* does not exist/i.test(e.message || '')) {
        // eslint-disable-next-line no-console
        console.error('[bookings] staff_id missing; self-healing column and retrying.');
        try { await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS staff_id UUID`; } catch {}
        insert = await doInsert();
      } else {
        throw e;
      }
    }
    // Auto-create the client-side chat thread + send the client a confirmation.
    // Don't notify the owner here (they're the one who just created it).
    notifyNewBooking({ workspaceId, bookingId: insert.rows[0].id, source: 'owner' });
    // Best-effort Google Calendar push. Failures log + skip; never block.
    syncOnBookingCreated({ workspaceId, bookingId: insert.rows[0].id });
    // Auto-send any intake forms the service has attached.
    attachIntakeForms({ workspaceId, bookingId: insert.rows[0].id });
    // Tell the owner the client just used their last session — actionable
    // moment to offer a renewal. Fire-and-forget; the booking still succeeds.
    if (packageExhaustionEvent) {
      notifyPackageExhausted({ workspaceId, ...packageExhaustionEvent });
    }
    return created(res, { booking: serializeBooking(insert.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}
