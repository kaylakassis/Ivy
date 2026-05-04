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

export function reportError(err, { req, extra } = {}) {
  // Always log to the function log so we have something even if Sentry
  // is wedged or DSN isn't set yet on this deploy.
  // eslint-disable-next-line no-console
  console.error('[monitoring]', err?.message || err, {
    method: req?.method,
    url: req?.url,
    ...(extra || {}),
  });

  // Fire-and-forget Sentry capture. Don't await — `reportError` is called
  // from request handlers and we don't want to delay the response.
  getClient().then((Sentry) => {
    if (!Sentry) return;
    try {
      Sentry.withScope((scope) => {
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
