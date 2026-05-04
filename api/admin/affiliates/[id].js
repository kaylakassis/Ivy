// PATCH  /api/admin/affiliates/:id  { code?, active?, displayName? }
// DELETE /api/admin/affiliates/:id
import { sql } from '../../_lib/db.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { requireSuperAdmin } from '../../_lib/admin.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../_lib/json.js';

const CODE_RE = /^[A-Z0-9_-]{3,40}$/;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const id = (req.query.id || '').toString();
    const r = await sql`SELECT * FROM affiliates WHERE id = ${id}`;
    if (r.rows.length === 0) return notFound(res, 'Affiliate not found');

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      if ('code' in body) {
        const c = String(body.code || '').trim().toUpperCase();
        if (!CODE_RE.test(c)) return badRequest(res, 'Code must be 3–40 chars; A–Z, 0–9, _ or -.');
        const dup = await sql`SELECT 1 FROM affiliates WHERE code = ${c} AND id <> ${id}`;
        if (dup.rows.length > 0) return badRequest(res, 'Code already in use.');
        await sql`UPDATE affiliates SET code = ${c}, updated_at = NOW() WHERE id = ${id}`;
      }
      if ('active' in body) {
        await sql`UPDATE affiliates SET active = ${!!body.active}, updated_at = NOW() WHERE id = ${id}`;
      }
      if ('displayName' in body) {
        const n = body.displayName == null ? null : String(body.displayName).slice(0, 200);
        await sql`UPDATE affiliates SET display_name = ${n}, updated_at = NOW() WHERE id = ${id}`;
      }
      return ok(res, { ok: true });
    }
    if (req.method === 'DELETE') {
      await sql`DELETE FROM affiliates WHERE id = ${id}`;
      return noContent(res);
    }
    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
