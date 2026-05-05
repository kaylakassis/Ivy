// /api/account/branding-logo-token
//   POST → mint a Vercel Blob client-upload token for the workspace
//          owner's brand logo. Image-only, 2 MB cap.
//
// After upload, the browser PATCHes /api/account/branding with the
// returned URL + pathname so the row references the new logo.
import { handleUpload } from '@vercel/blob/client';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const MAX_BYTES = 2 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return badRequest(res, 'Logo uploads not configured (BLOB_READ_WRITE_TOKEN missing)');
    }

    const body = await readBody(req);
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
