// Helper to read JSON request body in Vercel serverless functions.
// Vercel normally parses automatically, but some runtimes pass a stream.
//
// Hard cap at MAX_BYTES to keep a malicious 50MB JSON POST from OOM'ing
// the function or blowing past Vercel's per-request limits silently.
// Webhooks that need bigger bodies (none today) should use readRawBody
// and set their own cap; both helpers reject once the threshold is hit.
const MAX_BYTES = 4 * 1024 * 1024; // 4MB - matches Vercel's default request limit

class PayloadTooLargeError extends Error {
  constructor(seen) {
    super(`Request body exceeded ${MAX_BYTES} bytes (saw ${seen})`);
    this.code = 'payload_too_large';
    this.status = 413;
  }
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    if (req.body.length > MAX_BYTES) throw new PayloadTooLargeError(req.body.length);
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve, reject) => {
    let data = '';
    let seen = 0;
    req.on('data', (c) => {
      seen += c.length;
      if (seen > MAX_BYTES) {
        req.destroy();
        return reject(new PayloadTooLargeError(seen));
      }
      data += c;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Reads the request body as a raw string, no JSON parsing. Required for
// signature verification (e.g. Stripe webhooks) where a single byte of
// re-formatting would invalidate the HMAC.
//
// The handler that uses this must opt out of Vercel body parsing:
//   export const config = { api: { bodyParser: false } };
export async function readRawBody(req) {
  if (typeof req.body === 'string') {
    if (req.body.length > MAX_BYTES) throw new PayloadTooLargeError(req.body.length);
    return req.body;
  }
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > MAX_BYTES) throw new PayloadTooLargeError(req.body.length);
    return req.body.toString('utf8');
  }
  return await new Promise((resolve, reject) => {
    let data = '';
    let seen = 0;
    req.on('data', (c) => {
      seen += c.length;
      if (seen > MAX_BYTES) {
        req.destroy();
        return reject(new PayloadTooLargeError(seen));
      }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
