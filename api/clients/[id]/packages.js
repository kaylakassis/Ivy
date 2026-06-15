// /api/clients/:id/packages
//   GET  → list packages assigned to this client (active first)
//   POST → assign / sell a package. Body { packageId } binds the
//          template, OR a custom { name, sessionCount, price,
//          serviceIds?, expiryDays? } creates a one-off bundle without
//          a template (useful for "comp 5 sessions" or one-off deals).
//
// Sale doesn't auto-create an invoice yet — owners can pair this with
// the existing invoice flow themselves; deeper integration lands later.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { fetchOwnedClient } from '../../_lib/clients.js';
import { serializeClientPackage } from '../../_lib/packages.js';
import { badRequest, created, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id: clientId } = req.query;

    const client = await fetchOwnedClient({ id: clientId, workspaceId });
    if (!client) return notFound(res, 'Client not found');

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT * FROM client_packages
        WHERE client_id = ${clientId} AND workspace_id = ${workspaceId}
        ORDER BY
          CASE status WHEN 'active' THEN 0 ELSE 1 END,
          created_at DESC
      `;
      return ok(res, { packages: rows.map((r) => serializeClientPackage(r)) });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);

      // Two flavours: ref a template by packageId, OR pass a one-off
      // {name, sessionCount, price, ...}. Templates win on conflicts.
      let templateId = null;
      let name, serviceIds, sessionCount, price, expiryDays;

      if (body.packageId) {
        const tpl = await sql`
          SELECT * FROM packages
          WHERE id = ${String(body.packageId)} AND workspace_id = ${workspaceId}
            AND active = TRUE
        `;
        if (tpl.rows.length === 0) return badRequest(res, 'Package template not found or inactive');
        const t = tpl.rows[0];
        templateId   = t.id;
        name         = t.name;
        serviceIds   = t.service_ids || [];
        sessionCount = t.session_count;
        price        = Number(t.price);
        expiryDays   = t.expiry_days;
      } else {
        name = (body.name || '').toString().trim();
        sessionCount = Number(body.sessionCount);
        price        = Number(body.price);
        expiryDays   = body.expiryDays == null || body.expiryDays === '' ? null : Number(body.expiryDays);
        serviceIds   = Array.isArray(body.serviceIds)
          ? body.serviceIds.map((s) => String(s)).filter(Boolean).slice(0, 50)
          : [];

        if (!name) return badRequest(res, 'Name is required (or pass packageId)');
        if (!Number.isInteger(sessionCount) || sessionCount < 1 || sessionCount > 1000) {
          return badRequest(res, 'sessionCount must be 1–1000');
        }
        if (!Number.isFinite(price) || price < 0 || price > 1e7) {
          return badRequest(res, 'price must be a non-negative number');
        }
        if (expiryDays != null && (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 3650)) {
          return badRequest(res, 'expiryDays must be 1–3650');
        }
        if (serviceIds.length > 0) {
          const { rows } = await sql.query(
            'SELECT id FROM services WHERE workspace_id = $1 AND id = ANY($2)',
            [workspaceId, serviceIds],
          );
          if (rows.length !== serviceIds.length) return badRequest(res, 'One or more serviceIds not in this workspace');
        }
      }

      const expiresAt = expiryDays
        ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

      const { rows } = await sql`
        INSERT INTO client_packages (
          workspace_id, client_id, package_id,
          name, service_ids, credits_total, credits_remaining,
          price, expires_at
        ) VALUES (
          ${workspaceId}, ${clientId}, ${templateId},
          ${name}, ${serviceIds}, ${sessionCount}, ${sessionCount},
          ${price}, ${expiresAt}
        )
        RETURNING *
      `;
      return created(res, { package: serializeClientPackage(rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
