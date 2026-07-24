// /api/clients/:id/packages/:cpId
//   PATCH  → extend expiry, top up credits, change status (active /
//            cancelled). Doesn't touch the in-flight booking link.
//   DELETE → cancel. Sets status='cancelled' and credits_remaining=0.
//            Outstanding bookings keep their client_package_id so the
//            audit trail of "was paid by the cancelled bundle" survives.
import { sql } from '../../../_lib/db.js';
import { requireUser } from '../../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../../_lib/workspaceGate.js';
import { readBody } from '../../../_lib/body.js';
import { requireSameOrigin } from '../../../_lib/security.js';
import { fetchOwnedClient } from '../../../_lib/clients.js';
import { serializeClientPackage } from '../../../_lib/packages.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../../../_lib/json.js';

const VALID_STATUS = new Set(['active', 'cancelled']);

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id: clientId, cpId } = req.query;

    const client = await fetchOwnedClient({ id: clientId, workspaceId });
    if (!client) return notFound(res, 'Client not found');

    const found = await sql`
      SELECT * FROM client_packages
      WHERE id = ${cpId} AND client_id = ${clientId} AND workspace_id = ${workspaceId}
    `;
    if (found.rows.length === 0) return notFound(res, 'Package not found');
    const cur = found.rows[0];

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('addCredits' in body) {
        const n = Number(body.addCredits);
        if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 1000) {
          return badRequest(res, 'addCredits must be a non-zero integer (-1000…1000)');
        }
        // Atomic SQL delta, matching consumeCredit/restoreCredit. The old
        // read-modify-write (cur.credits_remaining + n computed in JS)
        // could silently undo a concurrent portal booking's consume -
        // a lost update worth a free session.
        values.push(n);
        const p = `$${values.length}`;
        sets.push(`credits_remaining = GREATEST(0, credits_remaining + ${p})`);
        if (n > 0) sets.push(`credits_total = credits_total + ${p}`);
        // Auto-reactivate on top-up, but ONLY when the body doesn't set
        // status explicitly - otherwise the UPDATE would carry two
        // `status =` assignments (a Postgres error). Explicit status wins.
        if (!('status' in body)) {
          sets.push(`status = CASE
            WHEN GREATEST(0, credits_remaining + ${p}) > 0
             AND status IN ('exhausted', 'cancelled')
            THEN 'active' ELSE status END`);
        }
      }
      if ('extendDays' in body) {
        const n = Number(body.extendDays);
        if (!Number.isInteger(n) || Math.abs(n) > 3650) {
          return badRequest(res, 'extendDays must be an integer (-3650…3650)');
        }
        const base = cur.expires_at ? new Date(cur.expires_at) : new Date();
        const next = new Date(base.getTime() + n * 24 * 60 * 60 * 1000);
        push('expires_at', next.toISOString());
      }
      if ('expiresAt' in body) {
        if (body.expiresAt == null || body.expiresAt === '') push('expires_at', null);
        else {
          const d = new Date(body.expiresAt);
          if (Number.isNaN(d.getTime())) return badRequest(res, 'expiresAt must be a date');
          push('expires_at', d.toISOString());
        }
      }
      if ('status' in body) {
        if (!VALID_STATUS.has(body.status)) return badRequest(res, 'status must be active or cancelled');
        push('status', body.status);
      }

      if (sets.length === 0) return ok(res, { package: serializeClientPackage(cur) });

      sets.push('updated_at = NOW()');
      values.push(cpId, clientId, workspaceId);
      const queryText = `
        UPDATE client_packages SET ${sets.join(', ')}
        WHERE id = $${values.length - 2} AND client_id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { package: serializeClientPackage(rows[0]) });
    }

    if (req.method === 'DELETE') {
      await sql`
        UPDATE client_packages SET status = 'cancelled', credits_remaining = 0, updated_at = NOW()
        WHERE id = ${cpId} AND client_id = ${clientId} AND workspace_id = ${workspaceId}
      `;
      return noContent(res);
    }

    return methodNotAllowed(res, ['PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
