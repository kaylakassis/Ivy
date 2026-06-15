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
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return badRequest(res, 'PDF uploads not configured (BLOB_READ_WRITE_TOKEN missing)');
    }

    const body = await readBody(req);
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
