// Tiny Sentry wrapper for the browser side.
//
// Activated when VITE_SENTRY_DSN is set at build time. Without it, the
// Sentry library is still imported (no way around the bundle hit), but
// init() is skipped so no events are sent.
//
// What we do capture:
//   • Uncaught exceptions
//   • Unhandled promise rejections
//   • Errors thrown inside React components (via SentryErrorBoundary)
//
// What we don't capture:
//   • Performance traces (tracesSampleRate=0) — saves bundle weight + cost
//   • Session replay — too privacy-sensitive without explicit opt-in
//
// Set VITE_SENTRY_DSN at build time on Vercel to flip it on.
import * as Sentry from '@sentry/react';

let initialised = false;

export function initMonitoring() {
  if (initialised) return;
  initialised = true;

  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE_SHA?.slice(0, 12) || undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    ignoreErrors: [
      // Browser noise that's never actionable.
      'ResizeObserver loop limit exceeded',
      'Non-Error promise rejection captured',
      // Browser-extension chatter
      /chrome-extension:/,
      /moz-extension:/,
    ],
    beforeSend(event) {
      if (event.request?.cookies) delete event.request.cookies;
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      return event;
    },
  });
}

// Re-export the bits we need from the SDK so feature code only imports
// our shim, not the SDK directly.
export const ErrorBoundary = Sentry.ErrorBoundary;
export const captureException = Sentry.captureException;
