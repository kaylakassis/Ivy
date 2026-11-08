// POST /api/automations/test  { kind, template? }
// "Send me a test": emails the signed-in owner their birthday,
// "we'd love to see you again" or book-again message with sample values (their own first
// name, their business). Nothing is recorded and no client is involved.
// Owner only, rate limited.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { sendTestAutomation, MAX_TEMPLATE_CHARS } from '../_lib/clientAutomations.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, [{ key: `automation-test:${workspaceId}`, max: 6, windowSeconds: 3600 }])) return;
    const body = await readBody(req);
    const kind = String(body.kind || '');
    const template = body.template == null ? null : String(body.template).slice(0, MAX_TEMPLATE_CHARS + 1);
    try {
      const out = await sendTestAutomation({ workspaceId, kind, to: user.email, ownerName: user.name, template });
      return ok(res, { sent: true, to: out.to });
    } catch (err) {
      return badRequest(res, err.message);
    }
  } catch (err) {
    return serverError(res, err);
  }
}
