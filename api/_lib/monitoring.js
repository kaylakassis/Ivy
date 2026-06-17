// Server monitoring — real Sentry when SENTRY_DSN is set, otherwise a
// console.error shim so dev / preview deploys don't need any infra.
//
// Sentry's Node SDK auto-instruments common libraries; we only hand it
// the basic config + DSN. Initialization is lazy so a missing SDK module
// (e.g. a stripped node_modules) can't kill cold starts — `reportError`
// always logs to the function log first, then best-effort forwards.
//
// Usage:
//   import { reportError } from './monitoring.js';
//   reportError(err, { req, extra: { invoiceId } });
//
// Required env: SENTRY_DSN (otherwise this module is a no-op forwarder)
// Optional env: SENTRY_ENVIRONMENT (defaults to VERCEL_ENV or 'production')
//               SENTRY_TRACES_SAMPLE_RATE (defaults to '0' = perf off)
//               SENTRY_MAX_PER_KEY_PER_HOUR (defaults to '20')
import crypto from 'crypto';
import { redact, redactObject } from './logRedact.js';

let _client = null;
let _initAttempted = false;

async function getClient() {
  if (_initAttempted) return _client;
  _initAttempted = true;
  if (!process.env.SENTRY_DSN) return null;
  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT
        || process.env.VERCEL_ENV
        || 'production',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),
      ignoreErrors: ['Unauthorized', 'Bad request'],
    });
    _client = Sentry;
    return _client;
  } catch (err) {
    // Don't let a Sentry init failure mask the underlying app error.
    // eslint-disable-next-line no-console
    console.warn('[monitoring] Sentry init failed:', err.message);
    _client = null;
    return null;
  }
}

// Source-side error sampling. Without this, a single bad code path at
// 10K users sends 10K errors to Sentry in the same minute and burns
// the monthly quota before anyone wakes up. Each unique error signature
// is capped at N captures per hour; the rest get logged-only.
//
// Signature = (message, top-of-stack frame). Cheap fingerprint.
// State is per-function-invocation (Vercel functions are short-lived);
// that's fine because the cap exists to prevent in-burst floods, not
// long-term suppression.
const MAX_PER_KEY = Number(process.env.SENTRY_MAX_PER_KEY_PER_HOUR || '20');
const HOUR_MS = 60 * 60 * 1000;
const _errorCounts = new Map(); // fingerprint -> { count, since }

function errorFingerprint(err) {
  const msg = err?.message || String(err);
  const firstFrame = (err?.stack || '').split('\n')[1] || '';
  return crypto.createHash('sha1').update(msg + '|' + firstFrame).digest('hex').slice(0, 16);
}

function shouldSampleToSentry(err) {
  const fp = errorFingerprint(err);
  const now = Date.now();
  const slot = _errorCounts.get(fp);
  if (!slot || (now - slot.since) > HOUR_MS) {
    _errorCounts.set(fp, { count: 1, since: now });
    return true;
  }
  slot.count++;
  return slot.count <= MAX_PER_KEY;
}

// Request ID propagation. Every API request gets a short ID stamped
// on its req object (via withMonitoring or requestId() lazy-getter)
// and echoed in the X-Request-Id response header. reportError + log
// helpers pull it in automatically so a single 500 in the response
// can be traced to every log line of the request that produced it.
export function requestId(req) {
  if (!req) return null;
  if (req._ivyRequestId) return req._ivyRequestId;
  const incoming = req.headers?.['x-request-id'];
  // Trust the upstream ID if it's a sensible shape (alphanumeric +
  // dashes, ≤ 64 chars), otherwise mint our own. Prevents header
  // injection (newlines, control chars) from contaminating logs.
  const id = (incoming && /^[A-Za-z0-9_-]{1,64}$/.test(incoming))
    ? incoming
    : crypto.randomBytes(8).toString('hex');
  req._ivyRequestId = id;
  return id;
}

export function reportError(err, { req, extra, workspaceId, userId } = {}) {
  const reqId = requestId(req);
  // Always log to the function log so we have something even if Sentry
  // is wedged or DSN isn't set yet on this deploy.
  // Logs feed third-party aggregators where any insider at that vendor
  // can read them — redact emails / phones / tokens before write.
  // eslint-disable-next-line no-console
  console.error('[monitoring]', redact(err?.message || String(err)), {
    requestId: reqId,
    method: req?.method,
    url: redact(req?.url),
    workspaceId, userId,
    ...redactObject(extra || {}),
  });

  if (!shouldSampleToSentry(err)) return null;

  // Fire-and-forget Sentry capture. Don't await — `reportError` is called
  // from request handlers and we don't want to delay the response.
  getClient().then((Sentry) => {
    if (!Sentry) return;
    try {
      Sentry.withScope((scope) => {
        if (reqId) scope.setTag('request_id', reqId);
        if (workspaceId) scope.setTag('workspace_id', workspaceId);
        if (userId) scope.setUser({ id: userId });
        if (req) {
          scope.setContext('request', {
            method: req.method,
            url: req.url,
            userAgent: req.headers?.['user-agent'],
          });
        }
        if (extra) scope.setContext('extra', extra);
        Sentry.captureException(err);
      });
    } catch {
      // Swallow — already logged above.
    }
  }).catch(() => { /* swallow */ });

  return null;
}

// Stamp the X-Request-Id response header. Call from any handler that
// wants the round-trip ID visible to the client (useful when a user
// reports an error — they paste the ID and we grep the logs).
export function stampRequestId(req, res) {
  const id = requestId(req);
  try { res.setHeader('X-Request-Id', id); } catch { /* response already sent */ }
  return id;
}
