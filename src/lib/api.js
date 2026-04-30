// Lightweight fetch wrapper against /api on Vercel serverless.
//
// Surfaces useful error messages: tries the JSON body first (our endpoints
// return { error, message } shapes), falls back to plain text, and always
// includes the HTTP status because Vercel runs HTTP/2 which omits the
// reason-phrase (statusText is empty).
async function req(method, path, body) {
  // Only set Content-Type when there's an actual body. Sending json content-type
  // on a bodiless DELETE/GET makes some serverless routing layers cranky.
  const headers = {};
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';

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
}

export const api = {
  get:   (p)     => req('GET',    p),
  post:  (p, b)  => req('POST',   p, b),
  put:   (p, b)  => req('PUT',    p, b),
  patch: (p, b)  => req('PATCH',  p, b),
  del:   (p)     => req('DELETE', p),
};
