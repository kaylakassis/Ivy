// POST /api/calendar/blocks — create a calendar block (manual unavailable time).
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeBlock } from '../_lib/calendar.js';
import { badRequest, created, methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const body = await readBody(req);
    const date = (body.date || '').toString();
    const start = Number(body.startMin);
    const end = Number(body.endMin);
    const label = body.label ? String(body.label).slice(0, 120) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'date must be YYYY-MM-DD');
    if (!Number.isInteger(start) || start < 0 || start >= 24 * 60) return badRequest(res, 'invalid startMin');
    if (!Number.isInteger(end) || end <= start || end > 24 * 60) return badRequest(res, 'invalid endMin');

    // Event fields layered on top of the original "block" shape.
    // blocksBookings defaults to TRUE (legacy behavior); color is
    // validated as #RGB or #RRGGBB to keep unrenderable junk out of
    // inline styles; notes/allDay optional.
    const blocksBookings = body.blocksBookings === undefined ? true : !!body.blocksBookings;
    const color = body.color && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(body.color)
      ? body.color : null;
    const notes  = body.notes ? String(body.notes).slice(0, 2000) : null;
    const allDay = !!body.allDay;

    const { rows } = await sql`
      INSERT INTO calendar_blocks (
        workspace_id, date, start_min, end_min, label,
        blocks_bookings, color, notes, all_day
      )
      VALUES (
        ${workspaceId}, ${date}, ${start}, ${end}, ${label},
        ${blocksBookings}, ${color}, ${notes}, ${allDay}
      )
      RETURNING *
    `;
    return created(res, { block: serializeBlock(rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}
