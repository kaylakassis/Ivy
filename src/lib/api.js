// Lightweight fetch wrapper against /api on Vercel serverless.
async function req(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error || res.statusText), { status: res.status, details: err });
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get:  (p)     => req('GET',    p),
  post: (p, b)  => req('POST',   p, b),
  put:  (p, b)  => req('PUT',    p, b),
  del:  (p)     => req('DELETE', p),
};
