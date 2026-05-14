// /api/calendar/bookings/upload-token
//   POST → mints a Vercel Blob client-upload token for a booking
//          completion-log attachment (photos + common docs). Same
//          MIME allowlist + 10MB cap as clients/upload-token.js.
//
// Pathname prefix is chosen client-side (typically
// `bookings/<id>/completion-<ts>.<ext>`) so blob storage stays
// organized per booking.
import { handleUpload } from '@vercel/blob/client';
import { requireUser, ensureWorkspace } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

const ALLOWED = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
const MAX_BYTES = 10 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return badRequest(res, 'Booking uploads not configured (BLOB_READ_WRITE_TOKEN missing)');
    }

    const body = await readBody(req);
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED,
        maximumSizeInBytes: MAX_BYTES,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ workspaceId, kind: 'completion' }),
      }),
      onUploadCompleted: async () => { /* no-op — bound on the next /complete POST/PATCH */ },
    });
    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
}
