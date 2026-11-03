// POST /api/clients/import - bulk-create clients from a parsed CSV, a
// contacts file (.vcf) or the phone's contact picker.
// Body: {
//   rows: [{ name, email?, phone?, stage?, notes?, source?, tags? }, ...],
//   sendInvites?: boolean   (default false: portal invites are opt-in)
//   quiet?: boolean         (default false; true = nothing is sent and no
//                            client_created / lead_created automation fires,
//                            whatever sendInvites says)
// }
// Behavior (shared with Ivy's import_clients_from_list, api/_lib/clientImport.js):
//   • De-dupes within the workspace by email first, then by normalized
//     phone. Existing rows are SKIPPED (not updated) so import can never
//     silently mutate hand-curated data. Rows with only a phone are fine.
//   • A row with neither email nor phone is still imported (name only).
//   • Returns { summary: { created, skipped, invalid, total, workflowsFired,
//     workflowsSkipped? }, errors[], inserted[], importedIds[] }.
//     importedIds lists the ids of the new clients in row order.
//
// All inserts are scoped to the authenticated user's workspace - nothing
// in the request body can override that.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import {
  prepareClientImport, insertPreparedClients, CLIENT_IMPORT_MAX_ROWS, CLIENT_IMPORT_WORKFLOW_SKIP_REASON,
} from '../_lib/clientImport.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, [{ key: `clients-import:ws:${workspaceId}`, max: 60, windowSeconds: 3600 }])) return;
    const body = await readBody(req);
    if (!Array.isArray(body.rows)) return badRequest(res, 'rows[] is required');
    if (body.rows.length === 0) return badRequest(res, 'No rows to import');
    if (body.rows.length > CLIENT_IMPORT_MAX_ROWS) {
      return badRequest(res, `Too many rows - split into batches of ${CLIENT_IMPORT_MAX_ROWS}`);
    }

    const plan = await prepareClientImport(workspaceId, body.rows, { onBadPhone: 'reject', defaultSource: 'CSV import' });
    const out = await insertPreparedClients(workspaceId, plan, {
      quiet: body.quiet === true,
      sendInvites: body.sendInvites === true,
      workflowSource: 'csv-import',
    });

    const errors = [
      ...plan.invalid.map((x) => ({ row: x.index + 1, error: x.error })),
      ...out.errors,
    ];
    return ok(res, {
      summary: {
        created: out.created,
        skipped: plan.duplicates.length,
        invalid: plan.invalid.length + out.invalid,
        total: body.rows.length,
        workflowsFired: out.workflowsFired,
        ...(out.workflowsSkipped ? { workflowsSkipped: true, workflowsSkippedReason: CLIENT_IMPORT_WORKFLOW_SKIP_REASON } : {}),
      },
      errors: errors.slice(0, 50), // cap so the response stays small
      inserted: out.inserted, // first 50 fully serialized, for optimistic UI
      importedIds: out.importedIds,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
