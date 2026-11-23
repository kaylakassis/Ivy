// POST /api/me/screen  body: { screen }
//
// The owner app says which screen was just opened (a name from the fixed
// list in api/_lib/screenVisits.js, nothing else). Used only for Admin >
// First week, which shows where new accounts stop. Owners only; an operator
// "viewing as" an owner is never counted. Always answers 204, so a failure
// here can never get in the way of the app.
import { requireUser, readSession } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { ownsWorkspace } from '../_lib/clientPortal.js';
import { recordScreenVisit } from '../_lib/screenVisits.js';
import { methodNotAllowed } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    if (!readSession(req)?.imp) {
      const body = await readBody(req);
      const ws = await ownsWorkspace(user.id);
      if (ws?.id) await recordScreenVisit({ userId: user.id, workspaceId: ws.id, screen: String(body?.screen || '') });
    }
  } catch { /* counting a screen is never worth an error */ }
  res.status(204).end();
}
