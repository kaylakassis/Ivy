// GET /api/calendar/public/:slug — public calendar state for the booking page.
// Returns settings + services + (block date+time only) + (booking date+time only).
// Client identities are redacted so other clients can't enumerate them.

import { sql } from '../../_lib/db.js';
import {
  serializeSettings, serializeService, serializeBlock, serializeBooking,
} from '../../_lib/calendar.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const slug = (req.query.slug || '').toString().toLowerCase();
    if (!slug) return notFound(res);

    const settings = await sql`
      SELECT * FROM calendar_settings WHERE slug = ${slug}
    `;
    if (settings.rows.length === 0) return notFound(res, 'No booking page for that handle');
    const s = settings.rows[0];

    const services = await sql`
      SELECT * FROM services WHERE workspace_id = ${s.workspace_id}
      ORDER BY display_order, created_at
    `;
    const blocks = await sql`
      SELECT * FROM calendar_blocks WHERE workspace_id = ${s.workspace_id}
      ORDER BY date, start_min
    `;
    const bookings = await sql`
      SELECT * FROM bookings WHERE workspace_id = ${s.workspace_id} AND cancelled_at IS NULL
      ORDER BY date, start_min
    `;

    return ok(res, {
      calendar: {
        settings: serializeSettings(s),
        services: services.rows.map(serializeService),
        blocks:   blocks.rows.map(serializeBlock),
        bookings: bookings.rows.map((r) => serializeBooking(r, { redactClient: true })),
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
