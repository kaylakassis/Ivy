// Cron run metrics. Wrap every cron handler with `trackCron(name, fn)`
// to stamp a row into cron_runs on completion. The admin cron-health
// dashboard reads from this to show per-cron success rate, latency
// trend, and "items processed" — turning crons from black boxes into
// observable scheduled jobs.
//
// The metrics row is best-effort: a DB write failure here must NEVER
// mask the cron's own success/failure status to the caller. The
// metrics insert itself is wrapped in try/catch.
import { sql } from './db.js';

// Wrap a cron handler. The wrapper:
//   1. Runs the handler.
//   2. Pulls "metrics" off the handler's response body (the convention
//      already established in api/cron/*: { sent, scanned, errors, ... })
//      so we capture the same numbers the handler returns to its caller.
//   3. Writes a cron_runs row with started_at, finished_at, duration_ms,
//      ok flag, metrics JSONB, and any error message.
//
// Usage:
//   export default trackCron('booking-reminders', async (req, res) => { ... });
export function trackCron(name, handler) {
  return async function trackedCronHandler(req, res) {
    const startedAt = new Date();
    const t0 = Date.now();

    // Tap the response to capture the body the handler sends back. We
    // wrap res.json + res.end so we see whatever shape the handler
    // returns, without forcing every cron to call a custom helper.
    let capturedBody = null;
    let capturedOk = null;
    const origJson = res.json?.bind(res);
    const origEnd  = res.end?.bind(res);
    if (origJson) {
      res.json = (body) => {
        capturedBody = body;
        capturedOk = (res.statusCode >= 200 && res.statusCode < 400);
        return origJson(body);
      };
    }
    if (origEnd) {
      res.end = (body, ...rest) => {
        if (capturedBody === null && body) {
          try { capturedBody = typeof body === 'string' ? JSON.parse(body) : body; }
          catch { capturedBody = { raw: String(body).slice(0, 200) }; }
        }
        if (capturedOk === null) {
          capturedOk = (res.statusCode >= 200 && res.statusCode < 400);
        }
        return origEnd(body, ...rest);
      };
    }

    let handlerErr = null;
    try {
      await handler(req, res);
    } catch (err) {
      handlerErr = err;
      if (capturedOk === null) capturedOk = false;
    }

    // Always insert the metrics row, even on failure — that's the
    // whole point. Wrap in try/catch so a metrics-table outage
    // never breaks the actual cron.
    const duration = Date.now() - t0;
    try {
      // Strip non-metric fields (like { ok: true } scaffolding) and
      // keep numeric/scalar fields that look like counts.
      const metrics = extractMetrics(capturedBody);
      await sql`
        INSERT INTO cron_runs (
          name, started_at, finished_at, duration_ms, ok, metrics, error_message
        ) VALUES (
          ${name}, ${startedAt.toISOString()}::timestamptz, NOW(), ${duration},
          ${capturedOk === null ? true : capturedOk},
          ${JSON.stringify(metrics)}::jsonb,
          ${handlerErr ? String(handlerErr.message || handlerErr).slice(0, 1000) : null}
        )
      `;
    } catch (metricsErr) {
      // eslint-disable-next-line no-console
      console.error(`[cronMetrics] write failed for ${name}:`, metricsErr.message);
    }

    // Re-throw if the handler threw — preserve original semantics so
    // Vercel logs the failure and (if configured) retries.
    if (handlerErr) throw handlerErr;
  };
}

// Pull only numeric / boolean / short-string fields from the response
// body for the metrics column. Skips nested objects + arrays so the
// metrics JSONB stays small and queryable.
function extractMetrics(body) {
  if (!body || typeof body !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 80) out[k] = v;
    // skip nested objects/arrays — too big for the metrics row
  }
  return out;
}
