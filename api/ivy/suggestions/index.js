// /api/ivy/suggestions
//   GET  → the signed-in owner's PENDING proactive suggestions ("Ivy noticed …").
//   POST → { id, action: 'done' | 'dismiss' } resolve one.
//
// Suggestions are produced by api/cron/ivy-agent.js. Acting on one just opens
// Ivy with its pre-filled prompt (client-side), which runs through Ivy's normal
// tools + confirm-gate — this endpoint only reads/dismisses, never sends.
import { requireUser, ensureWorkspace } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { listPendingSuggestions, resolveSuggestion } from '../../_lib/ivyAgent.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const suggestions = await listPendingSuggestions(workspaceId);
      return ok(res, { suggestions });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const id = body?.id ? String(body.id) : null;
      if (!id) return badRequest(res, 'id is required');
      const done = await resolveSuggestion(workspaceId, id, body?.action);
      return ok(res, { ok: done });
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (err) {
    return serverError(res, err);
  }
}
