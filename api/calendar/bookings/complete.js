// /api/calendar/bookings/complete
//   POST   → mark a single occurrence complete
//   PATCH  → edit an existing occurrence's completion (notes / attachments / visibility)
//   DELETE → un-mark an occurrence (rare - reversible-undo for stray clicks)
//
// Body shape (all methods take { id, occurrenceDate, ... }):
//   {
//     id:                          booking UUID,
//     occurrenceDate:              'YYYY-MM-DD' (the occurrence within a series,
//                                  or just the booking's own date),
//     completionNotes?:            string ≤ 8000,
//     completionAttachments?:      [{ url, blobPathname, mimeType, filename, uploadedAt }],
//     completionVisibleToClient?:  boolean
//   }
//
// State stored as a JSONB map on `bookings.completion_log` keyed by
// occurrenceDate - same per-occurrence pattern the app uses for
// `cancelled_occurrences`. POST returns 409 if that occurrence is
// already in the log (use PATCH to edit). Refuses when the booking
// is cancelled, the specific occurrence is cancelled, or the
// booking is marked no-show.
//
// Owner-only. Lives flat alongside no-show.js / tip.js so Vercel
// routes /complete here, /[id] to the dynamic handler.
import { del } from '@vercel/blob';
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { serializeBooking } from '../../_lib/calendar.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

const MAX_ATTACHMENTS = 20;
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function sanitizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item !== 'object') continue;
    const url = typeof item.url === 'string' ? item.url.slice(0, 1000) : null;
    const blobPathname = typeof item.blobPathname === 'string' ? item.blobPathname.slice(0, 400) : null;
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.slice(0, 100) : '';
    const filename = typeof item.filename === 'string' ? item.filename.slice(0, 300) : '';
    if (!url || !blobPathname) continue;
    if (mimeType && !ALLOWED_MIME.has(mimeType)) continue;
    out.push({
      url,
      blobPathname,
      mimeType,
      filename,
      uploadedAt: typeof item.uploadedAt === 'string' ? item.uploadedAt : new Date().toISOString(),
    });
  }
  return out;
}

function bestEffortDelete(pathnames) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  for (const p of pathnames) {
    if (!p) continue;
    del(p).catch((err) => {
      console.error('[bookings/complete] blob del failed for', p, err.message);
    });
  }
}

export default async function handler(req, res) {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) {
    return methodNotAllowed(res, ['POST', 'PATCH', 'DELETE']);
  }
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const body = await readBody(req);
    const id = body.id ? String(body.id) : null;
    const occurrenceDate = body.occurrenceDate ? String(body.occurrenceDate) : null;
    if (!id) return badRequest(res, 'id is required');
    if (!occurrenceDate || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) {
      return badRequest(res, 'occurrenceDate must be YYYY-MM-DD');
    }

    const r = await sql`
      SELECT * FROM bookings
       WHERE id = ${id} AND workspace_id = ${workspaceId}
       LIMIT 1
    `;
    const booking = r.rows[0];
    if (!booking) return notFound(res, 'Booking not found');
    if (booking.cancelled_at) return badRequest(res, "Can't complete a cancelled booking");
    if (booking.no_show_at) return badRequest(res, "Can't complete a no-show booking");

    const cancelledOccs = (booking.cancelled_occurrences || []).map((d) =>
      d instanceof Date ? d.toISOString().slice(0, 10) : String(d),
    );
    if (cancelledOccs.includes(occurrenceDate)) {
      return badRequest(res, "Can't complete a cancelled occurrence");
    }

    const log = booking.completion_log && typeof booking.completion_log === 'object'
      ? { ...booking.completion_log } : {};
    const existing = log[occurrenceDate] || null;

    // Look up staff_id for attribution display. Owner may not have a
    // staff_members row; that's fine - completedByStaffId stays null
    // and the UI falls back to "you".
    let staffId = null;
    if (booking.staff_id) {
      staffId = booking.staff_id;
    } else {
      const sm = await sql`
        SELECT id FROM staff_members
         WHERE workspace_id = ${workspaceId} AND user_id = ${user.id}
         LIMIT 1
      `;
      staffId = sm.rows[0]?.id || null;
    }

    if (req.method === 'POST') {
      if (existing) return badRequest(res, 'Already completed - use PATCH to edit');
      const notes = body.completionNotes == null
        ? '' : String(body.completionNotes).slice(0, 8000);
      const attachments = sanitizeAttachments(body.completionAttachments);
      const visibleToClient = body.completionVisibleToClient !== false;

      log[occurrenceDate] = {
        completedAt: new Date().toISOString(),
        completedByUserId: user.id,
        completedByStaffId: staffId,
        notes,
        attachments,
        visibleToClient,
      };
    } else if (req.method === 'PATCH') {
      if (!existing) return badRequest(res, 'No completion to edit - use POST to mark complete');
      const next = { ...existing };
      if ('completionNotes' in body) {
        next.notes = body.completionNotes == null ? '' : String(body.completionNotes).slice(0, 8000);
      }
      if ('completionAttachments' in body) {
        const newAtt = sanitizeAttachments(body.completionAttachments);
        const prev = Array.isArray(existing.attachments) ? existing.attachments : [];
        const prevPaths = new Set(prev.map((a) => a.blobPathname).filter(Boolean));
        const nextPaths = new Set(newAtt.map((a) => a.blobPathname).filter(Boolean));
        const orphans = [...prevPaths].filter((p) => !nextPaths.has(p));
        bestEffortDelete(orphans);
        next.attachments = newAtt;
      }
      if ('completionVisibleToClient' in body) {
        next.visibleToClient = !!body.completionVisibleToClient;
      }
      log[occurrenceDate] = next;
    } else if (req.method === 'DELETE') {
      if (!existing) return ok(res, { booking: serializeBooking(booking) });
      const prevPaths = Array.isArray(existing.attachments)
        ? existing.attachments.map((a) => a.blobPathname).filter(Boolean) : [];
      bestEffortDelete(prevPaths);
      delete log[occurrenceDate];
    }

    const upd = await sql`
      UPDATE bookings
         SET completion_log = ${JSON.stringify(log)}::jsonb,
             updated_at = NOW()
       WHERE id = ${id} AND workspace_id = ${workspaceId}
      RETURNING *
    `;
    return ok(res, { booking: serializeBooking(upd.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}
