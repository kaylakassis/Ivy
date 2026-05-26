// POST /api/clients/bulk  body: { action, ids, stage? }
//
// Bulk operations on clients. Owners managing 100+ clients used to
// have to tap each row's menu individually — this collapses that into
// one request. Actions:
//
//   archive   — set stage = 'paused' on every id
//   delete    — DELETE every id; cascades to clients-owned tables
//   set-stage — set stage = body.stage on every id (validates against
//                the allowed set: lead | active | paused)
//
// Hard-cap at 200 ids per request: a runaway "select all 10k" click
// would otherwise OOM the function (we audit + notify per id). The
// frontend's bulk actions bar splits >200 selections into multiple
// requests so the UI still looks like one operation.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { recordWorkspaceAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const VALID_ACTIONS = new Set(['archive', 'delete', 'set-stage']);
const VALID_STAGES  = new Set(['lead', 'active', 'paused']);
const MAX_IDS = 200;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);
    if (!(await requireActiveSubscription(workspaceId, req, res))) return;

    const body = await readBody(req);
    const action = String(body?.action || '');
    if (!VALID_ACTIONS.has(action)) {
      return badRequest(res, `action must be one of: ${[...VALID_ACTIONS].join(', ')}`);
    }
    const idsRaw = Array.isArray(body?.ids) ? body.ids : null;
    if (!idsRaw || idsRaw.length === 0) {
      return badRequest(res, 'ids must be a non-empty array');
    }
    if (idsRaw.length > MAX_IDS) {
      return badRequest(res, `Too many ids — cap is ${MAX_IDS} per request (got ${idsRaw.length})`);
    }
    const ids = idsRaw.map(String);

    let affected = 0;

    if (action === 'archive') {
      // 'archive' means stage=paused — we don't actually delete the
      // row, so historical bookings + invoices stay attached and the
      // owner can un-archive later.
      const r = await sql.query(
        `UPDATE clients SET stage = 'paused', updated_at = NOW()
           WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
        [workspaceId, ids],
      );
      affected = r.rowCount ?? 0;
    } else if (action === 'set-stage') {
      const stage = String(body?.stage || '');
      if (!VALID_STAGES.has(stage)) {
        return badRequest(res, `stage must be one of: ${[...VALID_STAGES].join(', ')}`);
      }
      const r = await sql.query(
        `UPDATE clients SET stage = $3, updated_at = NOW()
           WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
        [workspaceId, ids, stage],
      );
      affected = r.rowCount ?? 0;
    } else if (action === 'delete') {
      // CASCADE drops anything FK'd to clients(id) — bookings (set
      // null), invoices (set null), message_threads, etc — but
      // historical financial rows keep the data they need (client
      // name copied at creation). Workspace-scoped WHERE so a
      // crafted id list can't reach across tenants.
      const r = await sql.query(
        `DELETE FROM clients WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
        [workspaceId, ids],
      );
      affected = r.rowCount ?? 0;
    }

    // Audit ONCE per bulk operation rather than per id — keeps the
    // audit_events table from blowing up on a 200-row delete. meta
    // carries the id list + action for forensic reconstruction.
    recordWorkspaceAudit(req, {
      workspaceId, actor: user,
      action: `client.bulk.${action}`,
      target: { kind: 'clients-bulk', id: `${affected}-of-${ids.length}` },
      meta: {
        requested: ids.length,
        affected,
        ids: ids.slice(0, 50), // cap meta payload — first 50 ids is enough for forensics
        ...(action === 'set-stage' ? { stage: body.stage } : {}),
      },
    });

    return ok(res, { affected, requested: ids.length, action });
  } catch (err) {
    return serverError(res, err);
  }
}
