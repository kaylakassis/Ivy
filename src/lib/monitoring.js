// Frontend monitoring shim — Sentry was never installed via package.json,
// which broke clean builds on Vercel (Rollup couldn't resolve @sentry/react).
// This file preserves the public surface (initMonitoring, ErrorBoundary,
// captureException) so nothing downstream changes; re-add Sentry later by
// restoring git history on this file and installing @sentry/react.
import React from 'react';

export function initMonitoring() {
  // no-op — Sentry not wired up
}

export function captureException(err, _ctx) {
  // eslint-disable-next-line no-console
  console.error('[monitoring]', err);
}

// Minimal error boundary mirroring Sentry.ErrorBoundary's `fallback` prop.
// Falls back to a function (with { error, resetError }) or a React node.
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
