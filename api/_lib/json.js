// Small helpers for serverless handlers.
import { safeErrorMessage } from './security.js';
import { reportError } from './monitoring.js';

export function ok(res, body = {}) {
  return res.status(200).json(body);
}
export function created(res, body = {}) {
  return res.status(201).json(body);
}
export function noContent(res) {
  return res.status(204).end();
}
export function badRequest(res, message = 'Bad request', details) {
  return res.status(400).json({ error: message, details });
}
export function unauthorized(res, message = 'Unauthorized') {
  return res.status(401).json({ error: message });
}
export function notFound(res, message = 'Not found') {
  return res.status(404).json({ error: message });
}
export function methodNotAllowed(res, allowed = []) {
  res.setHeader('Allow', allowed.join(', '));
  return res.status(405).json({ error: 'Method not allowed' });
}
export function serverError(res, err, req) {
  // Log the full error server-side (Vercel captures console.error in logs)
  // but never let raw internals reach the client in production.
  // eslint-disable-next-line no-console
  console.error('[api] server error:', err);
  // Best-effort report to Sentry — no-ops if SENTRY_DSN isn't set. We
  // don't await it (Sentry buffers + flushes async) and we don't surface
  // the event id to the client to avoid leaking infra detail.
  try { reportError(err, { req }); } catch { /* ignore */ }
  return res.status(500).json({ error: safeErrorMessage(err) });
}
