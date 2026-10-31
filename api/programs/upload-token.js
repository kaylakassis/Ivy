// POST /api/programs/upload-token → Vercel Blob client-upload token for
// program files - same two-request dance as /api/clients/upload-token
// (see the comment there). The browser says what it is uploading in
// clientPayload ({ kind }), and the token only allows that kind's types
// and size:
//   (none)      PDFs and images, 25 MB (what older app builds send)
//   image       lesson gallery images, 25 MB
//   video       mp4 / mov / webm, 500 MB
//   audio       mp3 / m4a / wav, 100 MB
//   attachment  PDFs, documents, spreadsheets, slides, text, zip, images, 50 MB
import { handleUpload } from '@vercel/blob/client';
import { assertUploadPathname, UploadScopeError } from '../_lib/blobScope.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MB = 1024 * 1024;
const IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const UPLOAD_KINDS = {
  default:    { types: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'], max: 25 * MB },
  image:      { types: IMAGES, max: 25 * MB },
  video:      { types: ['video/mp4', 'video/quicktime', 'video/webm'], max: 500 * MB },
  audio:      { types: ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave'], max: 100 * MB },
  attachment: {
    types: ['application/pdf', ...IMAGES, 'text/plain', 'text/csv', 'application/zip', 'application/x-zip-compressed',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/epub+zip'],
    max: 50 * MB,
  },
};
const ALL_TYPES = [...new Set(Object.values(UPLOAD_KINDS).flatMap((k) => k.types))];
const ALL_MAX = Math.max(...Object.values(UPLOAD_KINDS).map((k) => k.max));
export function uploadKind(clientPayload) {
  let kind = null;
  try { kind = clientPayload ? JSON.parse(clientPayload)?.kind : null; } catch { kind = null; }
  return Object.prototype.hasOwnProperty.call(UPLOAD_KINDS, kind) && kind !== 'default' ? UPLOAD_KINDS[kind] : UPLOAD_KINDS.default;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return badRequest(res, "Uploads aren't available right now - please try again later or contact support");
    const body = await readBody(req);
    if (body?.type === 'blob.upload-completed') {
      const done = await handleUpload({ body, request: req,
        onBeforeGenerateToken: async () => ({ allowedContentTypes: ALL_TYPES, maximumSizeInBytes: ALL_MAX }),
        onUploadCompleted: async () => {} });
      return ok(res, done);
    }
    if (!requireSameOrigin(req, res)) return;
    const user = await requireUser(req, res); if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res); if (!workspaceId) return;
    const result = await handleUpload({ body, request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // Must sit under this workspace's blob prefix (api/_lib/blobScope.js).
        assertUploadPathname(pathname, workspaceId);
        const k = uploadKind(clientPayload);
        return { allowedContentTypes: k.types, maximumSizeInBytes: k.max, addRandomSuffix: true, tokenPayload: JSON.stringify({ workspaceId }) };
      },
      onUploadCompleted: async () => {} });
    return ok(res, result);
  } catch (err) {
    if (err instanceof UploadScopeError) return badRequest(res, err.message);
    return serverError(res, err);
  }
}
