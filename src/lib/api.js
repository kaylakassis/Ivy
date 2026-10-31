// Lightweight fetch wrapper against /api on Vercel serverless.
//
// Surfaces useful error messages: tries the JSON body first (our endpoints
// return { error, message } shapes), falls back to plain text, and always
// includes the HTTP status because Vercel runs HTTP/2 which omits the
// reason-phrase (statusText is empty).
// Retry transient cold-start failures once. The first request to a
// freshly-deployed serverless function instance can race the schema
// bootstrap (especially when ensureSchemaApplied() is running the full
// migration); the second request typically lands cleanly. We only
// retry GET / safe methods automatically, and only on 500-class errors
// or network failures - never on 4xx (those are deterministic).
//
// Native iOS (Capacitor) twist:
//   • The WebView origin is `capacitor://localhost` (iOS) or
//     `https://localhost` (Android), so a relative `/api/…` URL resolves
//     to the wrong place. We prepend VITE_API_BASE_URL
//     (e.g. https://joinivy.ai) on native.
//   • Cross-origin XHR drops the SameSite=Lax session cookie. We attach
//     `Authorization: Bearer <jwt>` (token stored in iOS Keychain via
//     src/lib/nativeAuth.js) and `X-Client-Platform: ios` so the server
//     knows to look at the header instead of the cookie.
import { isNative, getPlatform } from './platform.js';
import { getNativeAuthToken, primeNativeAuth } from './nativeAuth.js';

const RETRY_METHODS = new Set(['GET']);

// Empty on web (relative `/api/…` is same-origin), absolute on native
// builds. Vite inlines this at build time - at runtime it's a constant
// string per bundle.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

// Helper mode (api/_lib/helpers.js): while the helper shell is mounted
// every request names the business the helper is acting on. The server
// only honours it on routes that opted in, and only for the user's own
// memberships; it never widens access on its own.
let helperWorkspace = null;
export function setHelperWorkspace(id) { helperWorkspace = id || null; }
export function getHelperWorkspace() { return helperWorkspace; }

// Headers every request carries: JSON content type when there is a body,
// native auth on the iOS/Android shell, plus anything the caller adds.
async function buildHeaders(body, opts = {}) {
  // Only set Content-Type when there's an actual body. Sending json content-type
  // on a bodiless DELETE/GET makes some serverless routing layers cranky.
  const headers = {};
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  if (helperWorkspace) headers['X-Helper-Workspace'] = helperWorkspace;
  // Native auth - Bearer token + platform marker. The server's readSession
  // (api/_lib/auth.js) checks Authorization first, falls back to cookie.
  if (isNative()) {
    headers['X-Client-Platform'] = getPlatform();
    // First request after a cold start: load the token the last sign-in
    // stored on the device. Memoised, so this is a no-op afterwards.
    await primeNativeAuth();
    const tok = getNativeAuthToken();
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
  }
  // Caller-supplied headers (e.g. Idempotency-Key on mutating POSTs).
  if (opts.headers) Object.assign(headers, opts.headers);
  return headers;
}

// networkErr.message is browser jargon ("Load failed" on WebKit, "Failed to
// fetch" on Chromium). Say what a person can act on and keep the raw text on
// the error for diagnostics. status 0 = the request never got an answer.
function networkError(networkErr) {
  const aborted = networkErr?.name === 'AbortError';
  return Object.assign(
    new Error(aborted
      ? 'Request timed out - please try again.'
      : 'Could not reach Ivy. Check your connection and try again.'),
    { status: 0, cause: networkErr?.message || 'network error' },
  );
}

// Turns a non-2xx Response into the Error api.* throws: the server's own
// message when the body is our { error } shape, else the text, else the
// status. err.message is what screens show people. Never put the HTTP status
// in it ("401: Invalid email or password" reads like a crash). The status
// stays on err.status for code that needs to branch on it.
export async function httpError(res) {
  let detail = '';
  let parsed = null;
  try {
    const text = await res.text();
    try {
      parsed = JSON.parse(text);
      detail = parsed.error || parsed.message || '';
    } catch {
      // Not JSON (could be a Vercel error page or empty body).
      detail = text.slice(0, 280);
    }
  } catch { /* ignore body read errors */ }

  if (!detail && res.statusText) detail = res.statusText;
  if (!detail) detail = `HTTP ${res.status}`;
  return Object.assign(new Error(detail), { status: res.status, details: parsed });
}

// The raw fetch behind api.*, for a caller that reads the body itself (the
// Ivy reply stream). Same URL base, credentials, native auth and headers. A
// network failure throws the same status-0 error api.* does; the Response is
// returned as-is otherwise, non-2xx included (see httpError).
export async function apiFetch(method, path, body, opts = {}) {
  const headers = await buildHeaders(body, opts);
  try {
    return await fetch(`${API_BASE}/api${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
  } catch (networkErr) {
    throw networkError(networkErr);
  }
}

async function req(method, path, body, opts = {}) {
  const headers = await buildHeaders(body, opts);
  const url = `${API_BASE}/api${path}`;

  const doFetch = async () => {
    let res;
    // Optional timeout so a hung serverless function can't leave the UI
    // spinning forever (e.g. the Ivy load that "just keeps loading").
    // AbortController fires after opts.timeoutMs; the abort surfaces as
    // a status:0 error which the caller handles like any network error.
    const ctrl = opts.timeoutMs ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
    try {
      res = await fetch(url, {
        method,
        headers,
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (networkErr) {
      throw networkError(networkErr);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) throw await httpError(res);
    if (res.status === 204) return null;
    return res.json();
  };

  const canRetry = opts.retry !== false && (RETRY_METHODS.has(method) || opts.retry === true);
  try {
    return await doFetch();
  } catch (e) {
    const transient = e.status === 0 || (e.status >= 500 && e.status < 600);
    if (canRetry && transient) {
      await new Promise((r) => setTimeout(r, 600));
      return doFetch();
    }
    throw e;
  }
}

export const api = {
  get:   (p, opts)     => req('GET',    p, undefined, opts),
  post:  (p, b, opts)  => req('POST',   p, b, opts),
  put:   (p, b, opts)  => req('PUT',    p, b, opts),
  patch: (p, b, opts)  => req('PATCH',  p, b, opts),
  del:   (p, b, opts)  => req('DELETE', p, b, opts),
};
