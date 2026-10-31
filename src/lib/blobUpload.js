// Client-side uploads to Vercel Blob, native-aware.
//
// @vercel/blob's upload() first POSTs to our token route, then PUTs the
// file straight to Blob storage. On the web a relative token route and
// the session cookie are all it needs. In the iPhone app the page origin
// is capacitor://localhost, so a relative route never reaches the server
// and there is no cookie: the request has to go to the real API host
// with the Bearer token, exactly like src/lib/api.js does.
//
// Every upload in the app goes through this one function so the rules
// live in one place. The second rule: every pathname is placed under the
// uploading workspace's prefix, `ws/<workspaceId>/...`. The token routes
// refuse anything outside it (api/_lib/blobScope.js), which is what lets
// the server later delete only files that belong to the workspace.
import { upload } from '@vercel/blob/client';
import { isNative, getPlatform } from './platform.js';
import { getNativeAuthToken, primeNativeAuth } from './nativeAuth.js';
import { fetchMe } from './landing.js';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const PREFIX_RE = /^ws\/[A-Za-z0-9-]{8,64}\//;

// The workspace uploads belong to. Resolved from /api/me (shared, cached
// by fetchMe) the first time it is needed. `force` refetches - used when
// the server has just minted the workspace (a first upload by an account
// that had none yet) so a retry can carry the right prefix.
let knownWorkspaceId = null;
export function setUploadWorkspace(id) { knownWorkspaceId = id || null; }
async function workspaceIdForUploads({ force = false } = {}) {
  if (knownWorkspaceId && !force) return knownWorkspaceId;
  try {
    const me = await fetchMe({ force });
    knownWorkspaceId = me?.workspaceId || me?.owns?.id || null;
  } catch {
    knownWorkspaceId = null;
  }
  return knownWorkspaceId;
}

export function scopedPathname(pathname, workspaceId) {
  const clean = String(pathname || '').replace(/^\/+/, '');
  if (PREFIX_RE.test(clean)) return clean;
  return workspaceId ? `ws/${workspaceId}/${clean}` : clean;
}

export async function uploadFile(pathname, body, options = {}) {
  const { handleUploadUrl, headers: extra, ...rest } = options;
  if (!handleUploadUrl) throw new Error('handleUploadUrl is required');
  const headers = { ...(extra || {}) };
  let url = handleUploadUrl;
  if (isNative()) {
    await primeNativeAuth();
    const tok = getNativeAuthToken();
    if (tok) headers.Authorization = `Bearer ${tok}`;
    headers['X-Client-Platform'] = getPlatform();
    if (url.startsWith('/')) url = `${API_BASE}${url}`;
  }
  const opts = { ...rest, handleUploadUrl: url, headers };
  const wsId = await workspaceIdForUploads();
  try {
    return await upload(scopedPathname(pathname, wsId), body, opts);
  } catch (err) {
    // No workspace known yet (first upload by a brand-new account): the
    // token route has just created one, so learn it and try once more.
    if (!wsId) {
      const fresh = await workspaceIdForUploads({ force: true });
      if (fresh) return upload(scopedPathname(pathname, fresh), body, opts);
    }
    throw err;
  }
}
