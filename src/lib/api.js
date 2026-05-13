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
const RETRY_METHODS = new Set(['GET']);

async function req(method, path, body, opts = {}) {
  // Only set Content-Type when there's an actual body. Sending json content-type
  // on a bodiless DELETE/GET makes some serverless routing layers cranky.
  const headers = {};
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';

  const doFetch = async () => {
    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers,
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      throw Object.assign(new Error(networkErr.message || 'Network error'), {
        status: 0,
      });
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
  get:   (p)     => req('GET',    p),
  post:  (p, b)  => req('POST',   p, b),
  put:   (p, b)  => req('PUT',    p, b),
  patch: (p, b)  => req('PATCH',  p, b),
  del:   (p)     => req('DELETE', p),
};
