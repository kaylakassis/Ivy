// /api/messages/upload-token
//   POST → generates a Vercel Blob client token so the browser can upload
//          attachment files directly to Blob storage (bypasses our 4.5MB
//          serverless body limit and saves bandwidth costs).
//
// The flow is driven by @vercel/blob/client `handleUpload`. Steps:
//   1. Browser calls upload(...) → POSTs here with `blob.generate-client-token`
//   2. We authenticate, constrain (allowed types, max size), return a token
//   3. Browser uploads directly to Blob using the token
//   4. Browser POSTs here again with `blob.upload-completed` (we no-op; the
//      `messages` row insert is what records the URL)
//
// Requires BLOB_READ_WRITE_TOKEN env var (auto-set when a Blob store is
// linked to the Vercel project).
import { handleUpload } from '@vercel/blob/client';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const ALLOWED_CONTENT_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Voice memos. Chromium emits audio/webm (opus codec); Safari emits
  // audio/mp4. Browsers may suffix the codec - `audio/webm;codecs=opus`
  // - so we accept both the bare type and the codec-tagged variant.
  'audio/webm', 'audio/webm;codecs=opus',
  'audio/mp4', 'audio/mp4;codecs=mp4a.40.2',
  'audio/ogg', 'audio/ogg;codecs=opus',
  'audio/mpeg', 'audio/wav', 'audio/aac',
];

const MAX_BYTES = 10 * 1024 * 1024; // 10MB per file

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return badRequest(res, 'Attachment uploads not configured (BLOB_READ_WRITE_TOKEN missing)');
    }

    const body = await readBody(req);

    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // pathname comes from the browser as `<workspaceId>/messages/<filename>`.
        // We rebuild it server-side to guarantee the workspace prefix is correct,
        // and add a random suffix so users can't overwrite each other's files.
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ workspaceId, clientPayload }),
        };
      },
      onUploadCompleted: async () => {
        // No-op: the message insert records the URL, not a separate webhook.
      },
    });

    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
}
