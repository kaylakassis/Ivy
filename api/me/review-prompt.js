// POST /api/me/review-prompt  { answer?: 'yes'|'no'|'dismissed', action? }
// Records what the owner chose on the "Loving Ivy?" card.
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { recordReviewPromptAnswer, VALID_ANSWERS, VALID_ACTIONS } from '../_lib/reviewPrompt.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    if (await enforce(req, res, [{ key: `review-prompt:user:${user.id}`, max: 30, windowSeconds: 3600 }])) return;
    const body = await readBody(req);
    const answer = body.answer == null ? null : String(body.answer);
    const action = body.action == null ? null : String(body.action);
    if (!answer && !action) return badRequest(res, 'answer or action is required');
    if (answer && !VALID_ANSWERS.has(answer)) return badRequest(res, 'invalid answer');
    if (action && !VALID_ACTIONS.has(action)) return badRequest(res, 'invalid action');
    return ok(res, await recordReviewPromptAnswer({ userId: user.id, answer, action }));
  } catch (err) {
    return serverError(res, err);
  }
}
