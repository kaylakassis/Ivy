// Frontend monitoring. Real Sentry when VITE_SENTRY_DSN is set,
// otherwise a console.error shim so dev / preview deploys don't need
// any infra to render the app correctly.
//
// Public surface stays the same as the shim era:
//   initMonitoring()      - call once at app boot
//   captureException(err) - fire-and-forget log
//   <ErrorBoundary fallback={...}> - React error boundary
//
// Activate by setting in Vercel:
//   VITE_SENTRY_DSN          (required)
//   VITE_SENTRY_ENVIRONMENT  (optional, defaults to import.meta.env.MODE)
//   VITE_SENTRY_TRACES_RATE  (optional, defaults to 0 - perf off)
//
// VITE_-prefixed vars are exposed to the browser bundle by Vite. Anything
// else stays server-side.
import React from 'react';
import * as Sentry from '@sentry/react';

let _ready = false;

export function initMonitoring() {
  if (_ready) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  try {
    Sentry.init({
      dsn,
      environment: import.meta.env.VITE_SENTRY_ENVIRONMENT
        || import.meta.env.MODE
        || 'production',
      tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_RATE || '0'),
      // Drop common noise - chunk-load failures during deploys, browser
      // extensions, transient network errors. Real bugs still surface.
      ignoreErrors: [
        'Network request failed',
        'NetworkError',
        'AbortError',
        'ChunkLoadError',
        'Loading chunk',
        'Loading CSS chunk',
      ],
    });
    _ready = true;
  } catch (err) {
    // Don't let a Sentry init failure mask the app entirely.
    // eslint-disable-next-line no-console
    console.warn('[monitoring] Sentry init failed:', err.message);
  }
}

export function captureException(err, ctx) {
  // Always log to console first - useful in dev, also a backstop if
  // Sentry is wedged or hasn't initialized yet.
  // eslint-disable-next-line no-console
  console.error('[monitoring]', err, ctx || '');
  if (!_ready) return;
  try {
    Sentry.withScope((scope) => {
      if (ctx && typeof ctx === 'object') scope.setContext('extra', ctx);
      Sentry.captureException(err);
    });
  } catch {
    // Swallow - already logged above.
  }
}

// Minimal error boundary mirroring Sentry.ErrorBoundary's `fallback` prop.
// `fallback` can be a React node or a function ({ error, resetError }).
// Forwards caught errors to Sentry when configured.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.resetError = () => this.setState({ error: null });
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[monitoring] component error', error, info);
    if (_ready) {
      try {
        Sentry.withScope((scope) => {
          scope.setContext('react', { componentStack: info?.componentStack });
          Sentry.captureException(error);
        });
      } catch { /* swallow */ }
    }
  }
  render() {
    if (!this.state.error) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === 'function') {
      return fallback({ error: this.state.error, resetError: this.resetError });
    }
    return fallback || null;
  }
}
