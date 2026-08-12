// /api/documents/upload-token
//   POST → mint a Vercel Blob client-upload token so the browser can stream
//          a PDF directly to Blob (bypasses the 4.5 MB serverless body cap).
//
// Drives @vercel/blob/client `handleUpload` exactly like
// /api/messages/upload-token. PDF-only and capped at 25 MB. After upload
// the browser PATCHes /api/documents/:id with { fileUrl, kind: 'pdf',
// pageCount } so the document row points at the new file.
//
// Requires BLOB_READ_WRITE_TOKEN env var (auto-set when a Blob store is
// linked to the Vercel project).
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
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const ALLOWED_CONTENT_TYPES = ['application/pdf'];
const MAX_BYTES = 25 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return badRequest(res, 'Uploads aren\'t available right now - please try again later or contact support');
    }

    const body = await readBody(req);

    // Completion callback - server-to-server from Vercel Blob.
    // Don't try to auth it; handleUpload checks the signed token
    // internally. Relay it so the browser's upload() resolves.
    if (body?.type === 'blob.upload-completed') {
      const done = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async () => ({ allowedContentTypes: ALLOWED_CONTENT_TYPES, maximumSizeInBytes: MAX_BYTES }),
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
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: MAX_BYTES,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({ workspaceId }),
      }),
      onUploadCompleted: async () => {
        // No-op: the PATCH that ties the URL to the document row does the
        // bookkeeping. If that PATCH never lands, the orphan blob can be
        // garbage-collected later by an admin sweep.
      },
    });

    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
}
