// /api/packages/:id
//   PATCH  → edit any subset of name / description / serviceIds /
//            sessionCount / price / expiryDays / active
//   DELETE → soft-delete via active=false (preserves outstanding
//            client_packages that reference this template)
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializePackage } from '../_lib/packages.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;
    const { id } = req.query;

    const found = await sql`
      SELECT * FROM packages WHERE id = ${id} AND workspace_id = ${workspaceId}
    `;
    if (found.rows.length === 0) return notFound(res, 'Package not found');

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('name' in body) {
        const v = (body.name || '').toString().trim();
        if (!v) return badRequest(res, 'Name cannot be empty');
        if (v.length > 120) return badRequest(res, 'Name too long');
        push('name', v);
      }
      if ('description' in body) {
        push('description', body.description == null ? null : String(body.description).slice(0, 1000));
      }
      if ('serviceIds' in body) {
        if (!Array.isArray(body.serviceIds)) return badRequest(res, 'serviceIds must be an array');
        const ids = body.serviceIds.map((s) => String(s)).filter(Boolean).slice(0, 50);
        if (ids.length > 0) {
          const { rows } = await sql.query(
            'SELECT id FROM services WHERE workspace_id = $1 AND id = ANY($2)',
            [workspaceId, ids],
          );
          if (rows.length !== ids.length) return badRequest(res, 'One or more serviceIds are not in this workspace');
        }
        push('service_ids', ids);
      }
      if ('sessionCount' in body) {
        const n = Number(body.sessionCount);
        if (!Number.isInteger(n) || n < 1 || n > 1000) {
          return badRequest(res, 'sessionCount must be 1–1000');
        }
        push('session_count', n);
      }
      if ('price' in body) {
        const n = Number(body.price);
        if (!Number.isFinite(n) || n < 0 || n > 1e7) {
          return badRequest(res, 'price must be a non-negative number');
        }
        push('price', n);
      }
      if ('expiryDays' in body) {
        const v = body.expiryDays;
        if (v == null || v === '') push('expiry_days', null);
        else {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > 3650) {
            return badRequest(res, 'expiryDays must be 1–3650');
          }
          push('expiry_days', n);
        }
      }
      if ('active' in body) push('active', !!body.active);
      if ('visibility' in body) {
        const v = body.visibility;
        if (!['public', 'private', 'only_me'].includes(v)) {
          return badRequest(res, 'visibility must be public / private / only_me');
        }
        push('visibility', v);
      }

      if (sets.length === 0) return ok(res, { package: serializePackage(found.rows[0]) });

      sets.push('updated_at = NOW()');
      values.push(id, workspaceId);
      const queryText = `
        UPDATE packages SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { package: serializePackage(rows[0]) });
    }

    if (req.method === 'DELETE') {
      // Two modes:
      //   default → soft-delete (active = FALSE). Hides from sale UIs but
      //             leaves the template row so existing client_packages
      //             still join nicely.
      //   ?hard=1 → hard delete. Outstanding client_packages keep working
      //             because client_packages.package_id is ON DELETE SET
      //             NULL — they retain credits, name, and service ids
      //             from when the package was sold. Caller is expected
      //             to confirm with the owner first when there are
      //             still-active client packages.
      const hard = req.query.hard === '1' || req.query.hard === 'true';

      if (!hard) {
        await sql`
          UPDATE packages SET active = FALSE, updated_at = NOW()
          WHERE id = ${id} AND workspace_id = ${workspaceId}
        `;
        return noContent(res);
      }

      const { rows: stats } = await sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active' AND credits_remaining > 0) AS outstanding_clients,
          COALESCE(SUM(credits_remaining) FILTER (WHERE status = 'active' AND credits_remaining > 0), 0) AS outstanding_credits
        FROM client_packages
        WHERE workspace_id = ${workspaceId} AND package_id = ${id}
      `;
      const outstanding = {
        clients: Number(stats[0]?.outstanding_clients) || 0,
        credits: Number(stats[0]?.outstanding_credits) || 0,
      };

      // Without confirm=1 + outstanding > 0, surface the warning so the
      // UI can show a confirmation dialog. Defends against a misclick on
      // the trash button when the template is still in use.
      const confirmed = req.query.confirm === '1' || req.query.confirm === 'true';
      if (outstanding.clients > 0 && !confirmed) {
        return res.status(409).json({
          error: 'Outstanding client packages exist',
          outstanding,
        });
      }

      await sql`DELETE FROM packages WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
