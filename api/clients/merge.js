// /api/clients/merge - merge two client records of this business into one.
//
//   GET ?keepId=&removeId=  → { keep, remove, suggestedKeepId, fields,
//                               customFields, tags, optOuts, refusal,
//                               refusalCode, sentence }
//                             The side-by-side comparison for the merge sheet.
//   POST { keepId, removeId, fieldChoices? }
//        fieldChoices: { name|email|phone|address|birthday|stage: 'keep'|'remove',
//                        customFields: { [fieldId]: 'keep'|'remove' } }
//        → { merged: true, alreadyMerged, keptClientId, moved, client }
//        409 with { error, code } when the merge is refused (two different
//        portal accounts, autopay on two different cards).
//
// Owner only. One database transaction, exactly once per removed client
// (a double tap answers alreadyMerged: true and changes nothing). See
// api/_lib/clientMerge.js for the rules.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { serializeClient } from '../_lib/clients.js';
import { mergePreview, mergeClients, mergeSentence, MergeError, cleanId } from '../_lib/clientMerge.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, req.method === 'GET'
      ? [{ key: `client-merge:get:ws:${workspaceId}`, max: 600, windowSeconds: 3600 }]
      : [{ key: `client-merge:post:ws:${workspaceId}`, max: 120, windowSeconds: 3600 }])) return;

    if (req.method === 'GET') {
      const keepId = cleanId(req.query?.keepId);
      const removeId = cleanId(req.query?.removeId);
      if (!keepId || !removeId || keepId === removeId) return badRequest(res, 'Pick two different clients.');
      const preview = await mergePreview(workspaceId, keepId, removeId);
      return ok(res, { ...preview, sentence: mergeSentence(preview) });
    }

    const body = await readBody(req);
    const keepId = cleanId(body?.keepId);
    const removeId = cleanId(body?.removeId);
    if (!keepId || !removeId || keepId === removeId) return badRequest(res, 'Pick two different clients.');
    const out = await mergeClients({
      workspaceId, keepId, removeId, fieldChoices: body?.fieldChoices, actor: user, via: 'app', req,
    });
    const { rows } = await sql`SELECT * FROM clients WHERE id = ${out.keptClientId} AND workspace_id = ${workspaceId}`;
    return ok(res, { ...out, client: rows[0] ? serializeClient(rows[0]) : null });
  } catch (err) {
    if (err instanceof MergeError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    return serverError(res, err, req);
  }
}
