// GET /api/health — liveness check. Useful for Vercel deployments.
import { ok, methodNotAllowed } from './_lib/json.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  return ok(res, {
    status: 'ok',
    service: 'thryve-business-os',
    time: new Date().toISOString(),
  });
}
