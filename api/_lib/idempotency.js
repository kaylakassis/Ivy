// Client-side idempotency keys for mutating POST endpoints.
//
// Without this: a client retries on network error → server processes
// the request twice → duplicate booking, duplicate invoice, duplicate
// message. At scale this is constant - phone clients on flaky LTE
// retry the moment they see a timeout, even though the original
// request already completed server-side.
//
// Pattern (matches Stripe's Idempotency-Key contract):
//   1. Client generates a UUID once for an action, sends it as
//      `Idempotency-Key: <uuid>` header. On retry, same UUID.
//   2. Server calls withIdempotency(req, userId, async () => {...}).
//   3. First call: handler runs, response body cached on the row.
//      Subsequent calls with the same key: return the cached
//      response body WITHOUT re-running the handler.
//
// Storage: idempotency_records table, scoped by (user_id, key) to
// prevent cross-tenant collisions. TTL is 24h - long enough to
// catch any realistic retry, short enough that the table doesn't
// balloon. Cleanup runs in api/cron/db-prune.js.
import crypto from 'crypto';
import { sql } from './db.js';

const TTL_HOURS = 24;
const MAX_KEY_LEN = 200;

// Read the Idempotency-Key header. Returns null if absent OR
// malformed - handlers should treat null as "no idempotency
// requested" (i.e. run normally). Validates shape to prevent
// header injection / abuse (alphanumeric + a few punctuation,
// reasonable length).
export function readKey(req) {
  const raw = req.headers?.['idempotency-key'] || req.headers?.['x-idempotency-key'];
  if (!raw) return null;
  const k = String(raw).trim();
  if (!k || k.length > MAX_KEY_LEN) return null;
  if (!/^[A-Za-z0-9_\-:.]+$/.test(k)) return null;
  return k;
}

// Wrap a handler body. If the (userId, key) was already processed,
// returns the cached response without running fn. Otherwise runs
// fn, captures the response, stores it, returns the result.
//
// fn must return { status, body } where body is JSON-serializable.
// Caller is responsible for writing that to res - withIdempotency
// is purely a memoization layer, not a response shim. This keeps
// the API simple and lets callers decide what to write (json vs
// custom Content-Type, headers, etc.).
//
// userId can be null/undefined for unauthenticated endpoints; the
// key gets scoped under a magic 'anon' user. (Most idempotency
// keys are on authenticated mutations, but the public booking
// flow benefits from it too.)
export async function withIdempotency(req, userId, fn) {
  const key = readKey(req);
  if (!key) {
    // No idempotency requested - just run the handler.
    const result = await fn();
    return { ...result, idempotent: false };
  }
  const scope = userId || 'anon';
  // Stable per-request hash so we can detect a key REUSED across
  // semantically-different requests (same key, different POST body
  // → that's misuse, return 422 to surface the bug rather than
  // silently returning the prior response).
  const requestHash = hashRequest(req);

  // Look for a cached response first.
  // TTL_HOURS is a module-level constant (not user input) so inlining
  // it as a literal in the INTERVAL clause is safe - and necessary,
  // because tagged-template ${...} substitution treats it as a bound
  // parameter, which breaks `INTERVAL '$N hours'` syntax.
  try {
    const { rows } = await sql.query(
      `SELECT response_status, response_body, request_hash
         FROM idempotency_records
        WHERE scope = $1 AND key = $2
          AND created_at > NOW() - INTERVAL '${TTL_HOURS} hours'`,
      [scope, key],
    );
    if (rows.length > 0) {
      const cached = rows[0];
      if (cached.request_hash && cached.request_hash !== requestHash) {
        return {
          status: 422,
          body: { error: 'Idempotency-Key reused with a different request body' },
          idempotent: true, replayed: false,
        };
      }
      return {
        status: cached.response_status || 200,
        body:   cached.response_body,
        idempotent: true,
        replayed: true,
      };
    }
  } catch (err) {
    // Table missing on cold install OR transient DB failure: log
    // and run the handler without caching. Prefer "run twice
    // once" to "fail the request because the cache is down".
    // eslint-disable-next-line no-console
    console.warn('[idempotency] lookup failed; running uncached:', err.message);
    const result = await fn();
    return { ...result, idempotent: false };
  }

  // First time we've seen this key - run the handler.
  const result = await fn();

  // Best-effort store. If this fails the user still gets their
  // response; only retries within TTL would re-execute.
  try {
    await sql`
      INSERT INTO idempotency_records (
        scope, key, request_hash, response_status, response_body
      ) VALUES (
        ${scope}, ${key}, ${requestHash},
        ${result.status || 200},
        ${JSON.stringify(result.body || null)}::jsonb
      )
      ON CONFLICT (scope, key) DO NOTHING
    `;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[idempotency] store failed:', err.message);
  }

  return { ...result, idempotent: true, replayed: false };
}

// Hash the request body + path so we can detect key-reuse with a
// different body. We don't hash headers (they vary legitimately
// across retries - User-Agent jitter, Cookie refresh).
function hashRequest(req) {
  try {
    const path = req.url || '';
    // Body may be JSON-string or object depending on where the
    // handler buffered it. Serialize stably either way.
    const body = req.body
      ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
      : '';
    return crypto.createHash('sha256').update(path + '\n' + body).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}
