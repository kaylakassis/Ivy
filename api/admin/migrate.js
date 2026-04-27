// POST /api/admin/migrate — applies api/_lib/schema.sql.
// Protected by a shared secret; run once after first deploy.
//
// curl -X POST -H "x-admin-secret: $ADMIN_SECRET" https://your-app.vercel.app/api/admin/migrate

import fs from 'node:fs';
import path from 'node:path';
import { sql } from '../_lib/db.js';
import { ok, methodNotAllowed, serverError, unauthorized } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(500).json({ error: 'ADMIN_SECRET not set' });
  if (req.headers['x-admin-secret'] !== secret) return unauthorized(res);

  try {
    const schemaPath = path.join(process.cwd(), 'api', '_lib', 'schema.sql');
    const script = fs.readFileSync(schemaPath, 'utf8');
    // Split on `;` at end of line, strip line comments per-statement, then keep non-empty.
    const statements = script
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
