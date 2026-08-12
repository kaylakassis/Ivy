// /api/account/branding-logo-token
//   POST → mint a Vercel Blob client-upload token for the workspace
//          owner's brand logo. Image-only, 10 MB cap.
//
// After upload, the browser PATCHes /api/account/branding with the
// returned URL + pathname so the row references the new logo.
//
// IMPORTANT: this endpoint receives TWO request types from the
// @vercel/blob/client `upload()` flow:
//   1. 'blob.generate-client-token' — comes from the BROWSER with the
//      session cookie. We auth this normally (requireUser etc).
//   2. 'blob.upload-completed' — a server-to-server callback from
//      Vercel Blob's network the moment the upload finishes. It has
//      NO session cookie and NO matching Origin header. handleUpload
//      validates it via its own signed bearer token internally, so
//      we must NOT block it with requireUser/requireSameOrigin — if
//      we do, the browser-side `upload()` promise hangs forever
//      ("Uploading…" spinner that never resolves), even though the
//      blob itself uploaded successfully.
import { handleUpload } from '@vercel/blob/client';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
// 10 MB. Comfortable for high-res PNG/JPG straight from a phone camera
// (the most common upload path) without inviting truly outsized assets
// that would bloat every email render + slow the booking-site load.
const MAX_BYTES = 10 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return badRequest(res, 'Uploads aren\'t available right now - please try again later or contact support');
    }

    const body = await readBody(req);

    // Completion callback path — server-to-server from Vercel Blob.
    // Don't try to auth it; handleUpload checks the signed token
    // internally. We just relay the body so the protocol completes
    // and the browser's upload() promise resolves.
    if (body?.type === 'blob.upload-completed') {
      const result = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async () => ({ allowedContentTypes: ALLOWED, maximumSizeInBytes: MAX_BYTES }),
        onUploadCompleted: async () => { /* no-op; PATCH binds the URL */ },
      });
      return ok(res, result);
    }

    // Token-generation path — from the browser, needs full auth.
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
        tokenPayload: JSON.stringify({ workspaceId }),
      }),
      onUploadCompleted: async () => { /* no-op; PATCH binds the URL */ },
    });
    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
}
