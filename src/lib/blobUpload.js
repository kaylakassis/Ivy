// Client-side uploads to Vercel Blob, native-aware.
//
// @vercel/blob's upload() first POSTs to our token route, then PUTs the
// file straight to Blob storage. On the web a relative token route and
// the session cookie are all it needs. In the iPhone app the page origin
// is capacitor://localhost, so a relative route never reaches the server
// and there is no cookie: the request has to go to the real API host
// with the Bearer token, exactly like src/lib/api.js does.
//
// Every upload in the app goes through this one function so the rule
// lives in one place.
import { upload } from '@vercel/blob/client';
import { isNative, getPlatform } from './platform.js';
import { getNativeAuthToken, primeNativeAuth } from './nativeAuth.js';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

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
  return upload(pathname, body, { ...rest, handleUploadUrl: url, headers });
}
