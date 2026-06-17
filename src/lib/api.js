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
// or network failures — never on 4xx (those are deterministic).
//
// Native iOS (Capacitor) twist:
//   • The WebView origin is `https://localhost`, so a relative `/api/…`
//     URL resolves to the wrong place. We prepend VITE_API_BASE_URL
//     (e.g. https://getthryve.ai) on native.
//   • Cross-origin XHR drops the SameSite=Lax session cookie. We attach
//     `Authorization: Bearer <jwt>` (token stored in iOS Keychain via
//     src/lib/nativeAuth.js) and `X-Client-Platform: ios` so the server
//     knows to look at the header instead of the cookie.
import { isNative, getPlatform } from './platform.js';
import { getNativeAuthToken } from './nativeAuth.js';

const RETRY_METHODS = new Set(['GET']);

// Empty on web (relative `/api/…` is same-origin), absolute on native
// builds. Vite inlines this at build time — at runtime it's a constant
// string per bundle.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

async function req(method, path, body, opts = {}) {
  // Only set Content-Type when there's an actual body. Sending json content-type
  // on a bodiless DELETE/GET makes some serverless routing layers cranky.
  const headers = {};
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  // Native auth — Bearer token + platform marker. The server's readSession
  // (api/_lib/auth.js) checks Authorization first, falls back to cookie.
  if (isNative()) {
    headers['X-Client-Platform'] = getPlatform();
    const tok = getNativeAuthToken();
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
  }
  // Caller-supplied headers (e.g. Idempotency-Key on mutating POSTs).
  if (opts.headers) Object.assign(headers, opts.headers);

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
      const aborted = networkErr.name === 'AbortError';
      throw Object.assign(
        new Error(aborted ? 'Request timed out — please try again.' : (networkErr.message || 'Network error')),
        { status: 0 },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
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

      const message = `${res.status}: ${detail}`;
      throw Object.assign(new Error(message), { status: res.status, details: parsed });
    }
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
