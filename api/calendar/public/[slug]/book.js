// POST /api/calendar/public/:slug/book — create a booking via the public link.
// Validates slot is within availability, doesn't collide with blocks/bookings,
// and matches the service's duration.

import { sql } from '../../../_lib/db.js';
import { readBody } from '../../../_lib/body.js';
import { enforce, getClientIp } from '../../../_lib/rate-limit.js';
import { hasConflict, withinAvailability } from '../../../_lib/calendar.js';
import { validEmail } from '../../../_lib/auth.js';
import { badRequest, created, methodNotAllowed, notFound, serverError } from '../../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const slug = (req.query.slug || '').toString().toLowerCase();
    const body = await readBody(req);

    // Light rate limit: anyone can hit this without auth.
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `book:ip:${ip}`,    max: 10, windowSeconds: 60 * 60 },
      { key: `book:slug:${slug}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    // Resolve workspace by slug.
    const settingsRows = await sql`
      SELECT workspace_id, availability, slot_minutes FROM calendar_settings WHERE slug = ${slug}
    `;
    if (settingsRows.rows.length === 0) return notFound(res, 'Booking page not found');
    const { workspace_id: workspaceId, availability, slot_minutes: slotMinutes } = settingsRows.rows[0];

    // Validate inputs.
    const date = (body.date || '').toString();
    const start = Number(body.startMin);
    const end = Number(body.endMin);
    const serviceId = (body.serviceId || '').toString();
    const clientName = (body.clientName || '').toString().trim().slice(0, 120);
    const clientEmail = (body.clientEmail || '').toString().trim().toLowerCase();
    const notes = body.notes ? String(body.notes).slice(0, 1000) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'date must be YYYY-MM-DD');
    if (!Number.isInteger(start) || start < 0 || start >= 24 * 60) return badRequest(res, 'invalid startMin');
    if (!Number.isInteger(end) || end <= start || end > 24 * 60) return badRequest(res, 'invalid endMin');
    if ((end - start) % slotMinutes !== 0) return badRequest(res, `Slot must align to ${slotMinutes}-minute increments`);
    if (!clientName) return badRequest(res, 'Your name is required');
    if (!validEmail(clientEmail)) return badRequest(res, 'A valid email is required');
    if (!serviceId) return badRequest(res, 'Pick a service');

    // Verify service belongs to this workspace and duration matches.
    const svcRows = await sql`
      SELECT id, duration_minutes FROM services
      WHERE id = ${serviceId} AND workspace_id = ${workspaceId}
    `;
    if (svcRows.rows.length === 0) return badRequest(res, 'Unknown service');
    if ((end - start) !== svcRows.rows[0].duration_minutes) {
      return badRequest(res, 'Slot duration does not match service');
    }

    // Don't allow booking in the past.
    const now = new Date();
    const slotStart = new Date(date + 'T00:00:00Z');
    slotStart.setUTCMinutes(slotStart.getUTCMinutes() + start);
    if (slotStart.getTime() < now.getTime() - 60 * 1000) {
      return badRequest(res, 'That time has passed');
    }

    // Availability + conflict check.
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    if (!withinAvailability(availability, weekday, start, end)) {
      return badRequest(res, 'That slot is outside booking hours');
    }
    if (await hasConflict({ workspaceId, dateISO: date, start, end })) {
      return badRequest(res, 'That slot was just taken — please pick another time');
    }

    // Try to attach to an existing client by email (so the owner sees the booking
    // linked to their CRM). If not, create a lead with this name + email.
    let clientId = null;
    const existing = await sql`
      SELECT id FROM clients WHERE workspace_id = ${workspaceId} AND email = ${clientEmail} LIMIT 1
    `;
    if (existing.rows.length > 0) {
      clientId = existing.rows[0].id;
      await sql`UPDATE clients SET last_seen_at = NOW() WHERE id = ${clientId}`;
    } else {
      const newClient = await sql`
        INSERT INTO clients (workspace_id, name, email, stage, source, last_seen_at)
        VALUES (${workspaceId}, ${clientName}, ${clientEmail}, 'lead', 'Booking', NOW())
        RETURNING id
      `;
      clientId = newClient.rows[0].id;
    }

    const insert = await sql`
      INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, notes)
      VALUES (${workspaceId}, ${serviceId}, ${clientId}, ${clientName}, ${clientEmail}, ${date}, ${start}, ${end}, ${notes})
      RETURNING *
    `;
    const b = insert.rows[0];
    return created(res, {
      booking: {
        id: b.id,
        date: b.date instanceof Date ? b.date.toISOString().slice(0, 10) : b.date,
        startMin: b.start_min,
        endMin: b.end_min,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
