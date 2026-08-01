// /api/calendar/bookings/upload-token
//   POST → mints a Vercel Blob client-upload token for a booking
//          completion-log attachment (photos + common docs). Same
//          MIME allowlist + 10MB cap as clients/upload-token.js.
//
// Pathname prefix is chosen client-side (typically
// `bookings/<id>/completion-<ts>.<ext>`) so blob storage stays
// organized per booking.
//
// IMPORTANT: this endpoint receives TWO request types from the
// @vercel/blob/client `upload()` flow:
//   1. 'blob.generate-client-token' - from the BROWSER with the session
//      cookie. Authenticated normally.
//   2. 'blob.upload-completed' - a server-to-server callback from Vercel
//      Blob's network the moment the upload finishes. It has NO session
//      cookie and NO matching Origin header. handleUpload validates it
//      via its own signed bearer token internally, so we must NOT block
//      it with requireUser/requireSameOrigin - if we do, the browser's
//      `upload()` promise hangs forever ("Uploading..." spinner that
//      never resolves) even though the blob uploaded successfully.
import { handleUpload } from '@vercel/blob/client';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
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
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return badRequest(res, 'Booking uploads not configured (BLOB_READ_WRITE_TOKEN missing)');
    }

    const body = await readBody(req);

    // Completion callback - server-to-server from Vercel Blob.
    // Don't try to auth it; handleUpload checks the signed token
    // internally. Relay it so the browser's upload() resolves.
    if (body?.type === 'blob.upload-completed') {
      const done = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async () => ({ allowedContentTypes: ALLOWED, maximumSizeInBytes: MAX_BYTES }),
        onUploadCompleted: async () => { /* no-op; the URL is bound on the next PATCH */ },
      });
      return ok(res, done);
    }

    // Token-generation path - from the browser, needs full auth.
    if (!requireSameOrigin(req, res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED,
        maximumSizeInBytes: MAX_BYTES,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ workspaceId, kind: 'completion' }),
      }),
      onUploadCompleted: async () => { /* no-op - bound on the next /complete POST/PATCH */ },
    });
    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
}
