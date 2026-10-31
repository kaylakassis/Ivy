// Daily: send the weekly "Loving Ivy?" check-in push to owners who are due
// one. Per-owner cadence lives in api/_lib/reviewPrompt.js.
import { cronAuthorized } from '../_lib/cronAuth.js';
import { sendReviewPrompts } from '../_lib/reviewPrompt.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    return ok(res, await sendReviewPrompts());
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('review-ask', handler);
