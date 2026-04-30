// POST /api/calendar/blocks — create a calendar block (manual unavailable time).
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { serializeBlock } from '../_lib/calendar.js';
import { badRequest, created, methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    const date = (body.date || '').toString();
    const start = Number(body.startMin);
    const end = Number(body.endMin);
    const label = body.label ? String(body.label).slice(0, 120) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest(res, 'date must be YYYY-MM-DD');
    if (!Number.isInteger(start) || start < 0 || start >= 24 * 60) return badRequest(res, 'invalid startMin');
    if (!Number.isInteger(end) || end <= start || end > 24 * 60) return badRequest(res, 'invalid endMin');

    const { rows } = await sql`
      INSERT INTO calendar_blocks (workspace_id, date, start_min, end_min, label)
      VALUES (${workspaceId}, ${date}, ${start}, ${end}, ${label})
      RETURNING *
    `;
    return created(res, { block: serializeBlock(rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}
