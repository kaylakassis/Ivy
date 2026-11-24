// POST /api/me/exit-interview
//   body: { source?: 'cancel' | 'delete', reasons?: [...], comment?, skipped? }
//
// The signed-in owner's answer to "why are you leaving?". 'cancel' (the
// default) is asked after they turn renewal off or their plan ends;
// 'delete' is asked on the delete-account screen. skipped: true records
// "not now" so the app does not ask again for this cancellation (the email
// link still works). See api/_lib/exitInterview.js.
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { ownsWorkspace } from '../_lib/clientPortal.js';
import { cleanExitAnswer, recordExitAnswer } from '../_lib/exitInterview.js';
import { enforce } from '../_lib/rate-limit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (await enforce(req, res, [{ key: `exit-interview:user:${user.id}`, max: 20, windowSeconds: 60 * 60 }])) return;
    const ws = await ownsWorkspace(user.id);
    if (!ws?.id) return badRequest(res, 'Only a business account can answer this');
    const body = await readBody(req);
    const source = body?.source === 'delete' ? 'delete' : 'cancel';
    let answer;
    try { answer = cleanExitAnswer(body); } catch (err) { return badRequest(res, err.message); }
    // "Not now" only means something for a cancellation.
    if (source === 'delete' && answer.skipped) return ok(res, { saved: false });
    let out;
    try { out = await recordExitAnswer({ workspaceId: ws.id, source, channel: 'app', answer }); }
    catch (err) { return badRequest(res, err.message); }
    return ok(res, { saved: out.saved, already: !!out.already });
  } catch (err) {
    return serverError(res, err);
  }
}
