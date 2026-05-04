// Server monitoring shim — Sentry was never installed via package.json,
// which broke clean builds (and would break runtime imports on Vercel).
// Preserves the reportError export so json.js, bookingNotify.js, and
// the cron handlers don't need to change. Re-add Sentry by restoring
// this file from git and adding @sentry/node to package.json.

export function reportError(err, { req, extra } = {}) {
  // eslint-disable-next-line no-console
  console.error('[monitoring]', err?.message || err, {
    method: req?.method,
    url: req?.url,
    ...(extra || {}),
  });
  return null;
}
