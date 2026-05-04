// Helper to read JSON request body in Vercel serverless functions.
// Vercel normally parses automatically, but some runtimes pass a stream.
export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
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
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
