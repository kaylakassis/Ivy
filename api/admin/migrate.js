// POST /api/admin/migrate — applies the schema embedded in api/_lib/schema.js.
// Protected by a shared secret; run once after first deploy (and after each
// schema change that adds new statements; CREATE TABLE IF NOT EXISTS makes
// re-runs safe).
//
//   curl -X POST -H "x-admin-secret: $ADMIN_SECRET" https://your-app.vercel.app/api/admin/migrate

import { sql } from '../_lib/db.js';
import { SCHEMA_SQL } from '../_lib/schema.js';
import { ok, methodNotAllowed, serverError, unauthorized } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(500).json({ error: 'ADMIN_SECRET not set' });
  if (req.headers['x-admin-secret'] !== secret) return unauthorized(res);

  try {
    const statements = SCHEMA_SQL
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      // eslint-disable-next-line no-await-in-loop
      await sql.query(stmt);
    }
    return ok(res, { applied: statements.length });
  } catch (err) {
    return serverError(res, err);
  }
}
