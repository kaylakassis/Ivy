// GET /api/clients/:id/email-optouts
//
// Read-only history of this client's email opt-outs from the owner's
// business (unsubscribe link, one-click, or the client's own portal
// switches), newest first. There is deliberately no write method: only
// the client can turn their emails back on, from their own portal.
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { listClientOptOuts } from '../../_lib/clientOptouts.js';
import { effectiveClientEmailPrefs } from '../../_lib/notificationPrefs.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const clientId = String(req.query.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) return notFound(res, 'Client not found');
    const history = await listClientOptOuts({ workspaceId, clientId });
    if (!history) return notFound(res, 'Client not found');
    const prefs = await effectiveClientEmailPrefs(clientId);
    const mutedTypes = Object.keys(prefs).filter((t) => prefs[t] === false);
    return ok(res, { history, mutedTypes, ownerCanResubscribe: false });
  } catch (err) {
    return serverError(res, err);
  }
}
