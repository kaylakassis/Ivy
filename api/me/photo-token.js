// /api/me/photo-token
//   POST → mint a Vercel Blob client-upload token for the signed-in
//          person's own profile photo (client portal). Image-only, 5 MB.
//
// The portal crops the picture to a square in the browser and uploads a
// small JPEG; the pathname must sit under `user/<userId>/` (see
// api/_lib/blobScope.js), so one person can never write into another
// person's folder. After upload the browser PATCHes /api/me/profile with
// the returned URL, and that endpoint re-checks the URL against the same
// prefix instead of trusting it.
//
// Like the other token routes this receives TWO request types from the
// @vercel/blob/client upload() flow: the browser's token request (fully
// authenticated here) and Vercel Blob's server-to-server completion
// callback (no cookie; handleUpload verifies its signature itself).
import { handleUpload } from '@vercel/blob/client';
import { assertUserUploadPathname, UploadScopeError } from '../_lib/blobScope.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

// No SVG (it can carry script) and no HEIC (the browser crop re-encodes
// to JPEG anyway, so HEIC never reaches this route from the portal).
export const PHOTO_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return badRequest(res, 'Photo uploads aren\'t available right now. Please try again later.');
    }

    const body = await readBody(req);

    if (body?.type === 'blob.upload-completed') {
      const done = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async () => ({ allowedContentTypes: PHOTO_ALLOWED_TYPES, maximumSizeInBytes: PHOTO_MAX_BYTES }),
        onUploadCompleted: async () => { /* bound by the next /api/me/profile PATCH */ },
      });
      return ok(res, done);
    }

    if (!requireSameOrigin(req, res)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (await enforce(req, res, [{ key: `me-photo-token:${user.id}`, max: 20, windowSeconds: 60 * 60 }])) return;

    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        assertUserUploadPathname(pathname, user.id);
        return {
          allowedContentTypes: PHOTO_ALLOWED_TYPES,
          maximumSizeInBytes: PHOTO_MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId: user.id }),
        };
      },
      onUploadCompleted: async () => { /* bound by the next /api/me/profile PATCH */ },
    });
    return ok(res, result);
  } catch (err) {
    if (err instanceof UploadScopeError) return badRequest(res, err.message);
    return serverError(res, err);
  }
}
