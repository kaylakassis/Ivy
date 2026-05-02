// Tiny Sentry wrapper for serverless functions.
//
// Goals:
//   • Optional — if SENTRY_DSN isn't set, every call here is a cheap no-op.
//   • Idempotent init — Vercel hot-reloads can re-import this file, so we
//     guard the .init() call with a module-scoped flag.
//   • Send only what's useful: unhandled errors from serverError() in
//     api/_lib/json.js. We don't auto-instrument every request because
//     it'd flood the dashboard with 401/404 noise we already handle.
//
// Set SENTRY_DSN in Vercel envs to turn it on. SENTRY_ENV defaults to
// production / preview / development based on VERCEL_ENV.
import * as Sentry from '@sentry/node';

let initialised = false;

function maybeInit() {
  if (initialised) return Sentry;
  initialised = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENV
      || process.env.VERCEL_ENV   // 'production' | 'preview' | 'development'
      || 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12),
    tracesSampleRate: 0,          // no perf monitoring; just errors
    sendDefaultPii: false,
    beforeSend(event) {
      // Strip cookies / authorization headers as a final guard against
      // accidentally shipping session tokens to Sentry.
      if (event.request?.headers) {
        delete event.request.headers.cookie;
        delete event.request.headers.authorization;
        delete event.request.headers['x-admin-secret'];
      }
      return event;
    },
  });
  return Sentry;
}

// Manually report an error from a serverless handler. Returns a (possibly
// stringified) event ID for the response so support can correlate.
export function reportError(err, { req, extra } = {}) {
  const s = maybeInit();
  if (!s) return null;
  return s.captureException(err, {
    extra: {
      ...extra,
      method: req?.method,
      url: req?.url,
    },
  });
}
