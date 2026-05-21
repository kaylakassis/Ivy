// /api/packages
//   GET   → list this workspace's package templates (active + inactive)
//   POST  → create a template { name, description?, serviceIds?,
//                                sessionCount, price, expiryDays? }
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializePackage } from '../_lib/packages.js';
import { badRequest, created, methodNotAllowed, ok, serverError } from '../_lib/json.js';

function validateServiceIds(input) {
  if (input == null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'serviceIds must be an array' };
  const ids = input.map((s) => String(s)).filter(Boolean);
  if (ids.some((id) => !/^[0-9a-fA-F-]{36}$/.test(id))) {
    return { ok: false, error: 'serviceIds must be UUIDs' };
  }
  return { ok: true, value: ids.slice(0, 50) };
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;

    if (req.method === 'GET') {
      try {
        // Pull outstanding-credit summaries in the same query so the UI
        // can surface "this template is still in use" warnings without
        // a per-row round trip.
        const { rows } = await sql`
          SELECT p.*,
            COALESCE(stats.outstanding_clients, 0) AS outstanding_clients,
            COALESCE(stats.outstanding_credits, 0) AS outstanding_credits
          FROM packages p
          LEFT JOIN (
            SELECT package_id,
              COUNT(*) FILTER (WHERE status = 'active' AND credits_remaining > 0) AS outstanding_clients,
              SUM(credits_remaining) FILTER (WHERE status = 'active' AND credits_remaining > 0) AS outstanding_credits
            FROM client_packages
            WHERE workspace_id = ${workspaceId}
            GROUP BY package_id
          ) stats ON stats.package_id = p.id
          WHERE p.workspace_id = ${workspaceId}
          ORDER BY p.active DESC, p.name ASC
        `;
        const packages = rows.map((r) => ({
          ...serializePackage(r),
          outstandingClients: Number(r.outstanding_clients) || 0,
          outstandingCredits: Number(r.outstanding_credits) || 0,
        }));
        return ok(res, { packages });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[packages GET] failed (returning empty):', e.message);
        return ok(res, { packages: [] });
      }
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').toString().trim();
      const description = body.description == null ? null : String(body.description).slice(0, 1000);
      const sessionCount = Number(body.sessionCount);
      const price = Number(body.price);
      const expiryDays = body.expiryDays == null || body.expiryDays === ''
        ? null : Number(body.expiryDays);

      if (!name) return badRequest(res, 'Name is required');
      if (name.length > 120) return badRequest(res, 'Name too long');
      if (!Number.isInteger(sessionCount) || sessionCount < 1 || sessionCount > 1000) {
        return badRequest(res, 'sessionCount must be an integer 1–1000');
      }
      if (!Number.isFinite(price) || price < 0 || price > 1e7) {
        return badRequest(res, 'price must be a non-negative number');
      }
      if (expiryDays != null && (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 365 * 10)) {
        return badRequest(res, 'expiryDays must be 1–3650 or omitted');
      }
      const sv = validateServiceIds(body.serviceIds);
      if (!sv.ok) return badRequest(res, sv.error);

      const visibility = body.visibility || 'public';
      if (!['public', 'private', 'only_me'].includes(visibility)) {
        return badRequest(res, 'visibility must be public / private / only_me');
      }

      // Validate serviceIds belong to this workspace before storing.
      if (sv.value.length > 0) {
        const { rows: own } = await sql.query(
          'SELECT id FROM services WHERE workspace_id = $1 AND id = ANY($2)',
          [workspaceId, sv.value],
        );
        if (own.length !== sv.value.length) {
          return badRequest(res, 'One or more serviceIds are not in this workspace');
        }
      }

      const { rows } = await sql`
        INSERT INTO packages (workspace_id, name, description, service_ids, session_count, price, expiry_days, visibility)
        VALUES (${workspaceId}, ${name}, ${description}, ${sv.value}, ${sessionCount}, ${price}, ${expiryDays}, ${visibility})
        RETURNING *
      `;
      return created(res, { package: serializePackage(rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
