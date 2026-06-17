// GET /api/health — readiness check. Probes the database so a Postgres
// outage with otherwise-healthy functions reports as degraded (503)
// instead of falsely green. Used by Vercel + external uptime monitors.
import { sql } from './_lib/db.js';
import { methodNotAllowed } from './_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  let db = 'ok';
  try {
    await sql`SELECT 1`;
  } catch {
    db = 'down';
  }

  const healthy = db === 'ok';
  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    db,
    service: 'ivy-business-os',
    time: new Date().toISOString(),
  });
}
