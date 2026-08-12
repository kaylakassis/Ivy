// GET  /api/finance/tax-settings → { enabled, behavior, defaultTaxRate }
// PATCH /api/finance/tax-settings  { enabled?, behavior?, defaultTaxRate? }
//
// defaultTaxRate: the workspace's manual sales-tax %, seeded onto new
// invoices / POS sales / billed time so a retail-selling owner doesn't
// re-key it on every sale (or silently undercollect). Distinct from
// Stripe Tax, which computes jurisdiction tax at checkout.
//
// Toggles Stripe Tax for the workspace. Owners must independently
// configure tax registrations + thresholds in Stripe Dashboard
// (https://dashboard.stripe.com/tax) - flipping this flag on
// without registering jurisdictions will cause Stripe to throw at
// checkout. We surface that in the UI as a warning.
//
// behavior: optional 'inclusive' | 'exclusive'. Stripe defaults to
// exclusive (price is pre-tax, tax added on top) which matches US
// expectations; EU sellers typically prefer inclusive (price IS the
// tax-included total).
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const VALID_BEHAVIORS = new Set(['inclusive', 'exclusive']);

export default async function handler(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'GET') {
    return methodNotAllowed(res, ['GET', 'PATCH']);
  }
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT stripe_tax_enabled, stripe_tax_behavior, default_tax_rate
          FROM finance_settings WHERE workspace_id = ${workspaceId}
      `;
      const row = rows[0] || {};
      return ok(res, {
        enabled:        !!row.stripe_tax_enabled,
        behavior:       row.stripe_tax_behavior || null,
        defaultTaxRate: Number(row.default_tax_rate || 0),
      });
    }

    const body = await readBody(req);

    const enabled = typeof body.enabled === 'boolean' ? body.enabled : null;
    let defaultTaxRate;
    if ('defaultTaxRate' in body) {
      const n = Number(body.defaultTaxRate);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return badRequest(res, 'Default tax rate must be between 0 and 100');
      }
      defaultTaxRate = Math.round(n * 1000) / 1000;
    }
    let behavior;
    if ('behavior' in body) {
      const b = body.behavior;
      if (b === null || b === '') behavior = null;
      else if (VALID_BEHAVIORS.has(b)) behavior = b;
      else return badRequest(res, 'behavior must be inclusive, exclusive, or null');
    }

    // Ensure a row exists first (most workspaces have one; brand-new
    // ones might not until they hit the Finance tab).
    await sql`
      INSERT INTO finance_settings (workspace_id)
      VALUES (${workspaceId})
      ON CONFLICT (workspace_id) DO NOTHING
    `;

    const sets = [];
    const params = [workspaceId];
    if (enabled !== null) {
      params.push(enabled);
      sets.push(`stripe_tax_enabled = $${params.length}`);
    }
    if (behavior !== undefined) {
      params.push(behavior);
      sets.push(`stripe_tax_behavior = $${params.length}`);
    }
    if (defaultTaxRate !== undefined) {
      params.push(defaultTaxRate);
      sets.push(`default_tax_rate = $${params.length}`);
    }
    if (sets.length === 0) {
      return badRequest(res, 'No settings to update');
    }

    const { rows } = await sql.query(
      `UPDATE finance_settings SET ${sets.join(', ')}
       WHERE workspace_id = $1
       RETURNING stripe_tax_enabled, stripe_tax_behavior, default_tax_rate`,
      params,
    );
    const row = rows[0] || {};
    return ok(res, {
      enabled:        !!row.stripe_tax_enabled,
      behavior:       row.stripe_tax_behavior || null,
      defaultTaxRate: Number(row.default_tax_rate || 0),
    });
  } catch (err) {
    return serverError(res, err);
  }
}
