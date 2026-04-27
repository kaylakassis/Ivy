// Small helpers for serverless handlers.
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
export function serverError(res, err) {
  return res.status(500).json({ error: 'Server error', message: err?.message });
}
