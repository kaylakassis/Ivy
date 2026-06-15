// /api/clients/photo-token
//   POST → mint a Vercel Blob client-upload token for a client photo
//          (profile pic OR gallery entry). 8 MB cap, image-only.
//
// After upload, the browser PATCHes /api/clients/<id> with either
// `photoUrl` (profile pic) or `galleryPhotos: [...]` (gallery array).
//
// Mirrors api/calendar/services/photo-token + account/branding-logo-token.
// One token covers both surfaces — same MIME allow-list, same workspace
// scoping; the caller decides which field on the client to bind the
// returned URL to.
import { handleUpload } from '@vercel/blob/client';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const ALLOWED = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
];
const MAX_BYTES = 8 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return badRequest(res, 'Photo uploads not configured (BLOB_READ_WRITE_TOKEN missing)');
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
      onUploadCompleted: async () => { /* the URL is bound on the next clients PATCH */ },
    });
    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
}
