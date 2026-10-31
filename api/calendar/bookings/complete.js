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
//     completionAttachments?:      [{ url, mimeType, filename, uploadedAt }],
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
// Attachments and Blob storage: the browser sends { url, ... } for each
// file it uploaded through /api/calendar/bookings/upload-token. The
// stored `blobPathname` is NEVER taken from the request - it is derived
// from the URL and kept only when the object sits under this
// workspace's blob prefix (api/_lib/blobScope.js). Files already on the
// log keep the pathname we stored for them. When attachments are
// dropped we del() only pathnames that pass the same workspace check;
// anything else (another host, another workspace, a legacy unprefixed
// upload) is left alone.
//
// Helpers (schedule permission) may mark complete and edit notes but
// never attach files: their attachments are ignored.
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
import { blobPathnameForWorkspace, scopedBlobPathnames } from '../../_lib/blobScope.js';
import { markComplete, undoComplete, assertCompletable, completionLogOf, CompletionError } from '../../_lib/completion.js';
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

// `existing` is the attachment list already stored for this occurrence
// (PATCH); a URL that is already on it keeps its stored pathname.
export function sanitizeAttachments(input, workspaceId, existing = []) {
  if (!Array.isArray(input)) return [];
  const storedPathByUrl = new Map(
    (Array.isArray(existing) ? existing : []).filter((a) => a?.url).map((a) => [a.url, a.blobPathname || null]),
  );
  const out = [];
  for (const item of input.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item !== 'object') continue;
    const url = typeof item.url === 'string' ? item.url.slice(0, 1000) : null;
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType.slice(0, 100) : '';
    const filename = typeof item.filename === 'string' ? item.filename.slice(0, 300) : '';
    if (!url) continue;
    if (mimeType && !ALLOWED_MIME.has(mimeType)) continue;
    out.push({
      url,
      blobPathname: storedPathByUrl.has(url) ? storedPathByUrl.get(url) : blobPathnameForWorkspace(url, workspaceId),
      mimeType,
      filename,
      uploadedAt: typeof item.uploadedAt === 'string' ? item.uploadedAt : new Date().toISOString(),
    });
  }
  return out;
}

// Delete, best effort, only the objects this workspace owns.
function bestEffortDelete(pathnames, workspaceId) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  for (const p of scopedBlobPathnames(pathnames, workspaceId)) {
    del(p).catch((err) => {
      console.error('[bookings/complete] blob del failed:', err.message);
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
    const workspaceId = await ensureActiveWorkspace(user, req, res, { helper: 'schedule' });
    if (!workspaceId) return;
    // Helper mode: no revenue in the response, no file attachments.
    const bopts = { redactMoney: !!req.helper };

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

    try {
      if (req.method === 'POST') {
        // The shared helper (api/_lib/completion.js) owns the refusals
        // (cancelled, no-show, already complete) so the helper endpoint
        // behaves identically.
        const row = await markComplete({
          booking, occurrenceDate, userId: user.id, staffId,
          notes: body.completionNotes,
          attachments: req.helper ? [] : sanitizeAttachments(body.completionAttachments, workspaceId),
          visibleToClient: body.completionVisibleToClient !== false,
        });
        return ok(res, { booking: serializeBooking(row, bopts) });
      }

      if (req.method === 'DELETE') {
        const { booking: row, removed } = await undoComplete({ booking, occurrenceDate });
        if (removed) {
          const prevPaths = Array.isArray(removed.attachments)
            ? removed.attachments.map((a) => a.blobPathname).filter(Boolean) : [];
          bestEffortDelete(prevPaths, workspaceId);
        }
        return ok(res, { booking: serializeBooking(row, bopts) });
      }

      // PATCH: edit an existing occurrence's completion.
      assertCompletable(booking, occurrenceDate);
      const log = completionLogOf(booking);
      const existing = log[occurrenceDate] || null;
      if (!existing) return badRequest(res, 'No completion to edit - use POST to mark complete');
      const next = { ...existing };
      if ('completionNotes' in body) {
        next.notes = body.completionNotes == null ? '' : String(body.completionNotes).slice(0, 8000);
      }
      // Helpers cannot attach or remove files: the key is ignored and the
      // owner's attachments stay exactly as they are.
      if ('completionAttachments' in body && !req.helper) {
        const prev = Array.isArray(existing.attachments) ? existing.attachments : [];
        const newAtt = sanitizeAttachments(body.completionAttachments, workspaceId, prev);
        const prevPaths = new Set(prev.map((a) => a.blobPathname).filter(Boolean));
        const nextPaths = new Set(newAtt.map((a) => a.blobPathname).filter(Boolean));
        const orphans = [...prevPaths].filter((p) => !nextPaths.has(p));
        bestEffortDelete(orphans, workspaceId);
        next.attachments = newAtt;
      }
      if ('completionVisibleToClient' in body) {
        next.visibleToClient = !!body.completionVisibleToClient;
      }
      log[occurrenceDate] = next;
      const upd = await sql`
        UPDATE bookings
           SET completion_log = ${JSON.stringify(log)}::jsonb,
               updated_at = NOW()
         WHERE id = ${id} AND workspace_id = ${workspaceId}
        RETURNING *
      `;
      return ok(res, { booking: serializeBooking(upd.rows[0], bopts) });
    } catch (e) {
      if (e instanceof CompletionError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  } catch (err) {
    return serverError(res, err);
  }
}
