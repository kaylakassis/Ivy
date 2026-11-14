// /api/admin/risk - fraud protection for the operator (super-admins only).
//
//   GET  → { accounts: [...] } businesses on hold, plus businesses with a
//          flag nobody has reviewed yet (api/_lib/riskHold.js).
//   POST → { action, workspaceId?, reason? }
//          hold      take a business offline (reason required)
//          release   lift a hold
//          reviewed  "looks fine": hide until something new is flagged
//          sync      ask Stripe about every connected account now and
//                    apply the answers (a rejection places a hold)
//          limits    change the card payment limits for businesses
//                    Stripe has not verified yet ({ limits: {...} })
//
// Every action is written to the audit log with who did it.
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { readBody } from '../_lib/body.js';
import { sql } from '../_lib/db.js';
import {
  listRiskAccounts, placeRiskHold, releaseRiskHold, markRiskReviewed, syncStripeAccountStatuses,
} from '../_lib/riskHold.js';
import { getLimits, setLimits, describeLimits } from '../_lib/newBusinessLimits.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;
  try {
    res.setHeader?.('Cache-Control', 'no-store');
    if (req.method === 'GET') {
      const limits = await getLimits();
      return ok(res, { accounts: await listRiskAccounts(), limits, limitsText: describeLimits(limits) });
    }

    const body = await readBody(req);
    const action = String(body.action || '');
    const actor = await getAdminActor(req);
    const by = actor?.email || 'admin';

    if (action === 'sync') {
      const out = await syncStripeAccountStatuses({ limit: 300, deadlineMs: 20000 });
      await recordAudit(req, { actor, action: 'risk.sync', meta: out });
      return ok(res, { ...out, accounts: await listRiskAccounts() });
    }

    // The new-business payment limits (api/_lib/newBusinessLimits.js).
    if (action === 'limits') {
      const before = await getLimits();
      const limits = await setLimits(body.limits);
      await recordAudit(req, { actor, action: 'risk.limits', meta: { before, after: limits } });
      return ok(res, { ok: true, limits, limitsText: describeLimits(limits) });
    }

    const workspaceId = String(body.workspaceId || '');
    if (!UUID_RE.test(workspaceId)) return badRequest(res, 'Pick a business first.');
    const ws = (await sql`SELECT id, owner_id FROM workspaces WHERE id = ${workspaceId}`).rows[0];
    if (!ws) return notFound(res, 'That business was not found.');

    if (action === 'hold') {
      const reason = String(body.reason || '').trim().slice(0, 300);
      if (!reason) return badRequest(res, 'Say why, so there is a record of it.');
      const out = await placeRiskHold({ workspaceId, reason, source: 'admin', actor: by });
      if (!out.ok && out.reason === 'operator-account') return badRequest(res, 'An admin account cannot be put on hold.');
      if (!out.ok) return badRequest(res, 'Could not place the hold.');
      await recordAudit(req, { actor, targetUserId: ws.owner_id, action: 'risk.hold', meta: { workspaceId, reason, placed: out.placed } });
      return ok(res, { ok: true, placed: out.placed, accounts: await listRiskAccounts() });
    }
    if (action === 'release') {
      const out = await releaseRiskHold({ workspaceId, actor: by });
      await recordAudit(req, { actor, targetUserId: ws.owner_id, action: 'risk.release', meta: { workspaceId, released: out.released } });
      return ok(res, { ok: true, released: out.released, accounts: await listRiskAccounts() });
    }
    if (action === 'reviewed') {
      await markRiskReviewed({ workspaceId, actor: by });
      await recordAudit(req, { actor, targetUserId: ws.owner_id, action: 'risk.reviewed', meta: { workspaceId } });
      return ok(res, { ok: true, accounts: await listRiskAccounts() });
    }
    return badRequest(res, 'Unknown action.');
  } catch (err) {
    return serverError(res, err);
  }
}
