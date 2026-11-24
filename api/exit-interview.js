// /api/exit-interview?token=...   (no sign-in: the link in the email)
//   GET  → { ok, business, reasons: [{ id, label }], answered }
//   POST → body { reasons?: [...], comment? } records the answer
//
// The token is signed for one business and expires (api/_lib/
// exitInterview.js). It can only ever add that business's own answer to
// "why did you cancel?"; it reads nothing else and changes nothing else.
// A bad or expired link gets the same plain "not found".
import { sql } from './_lib/db.js';
import { readBody } from './_lib/body.js';
import { requireSameOrigin } from './_lib/security.js';
import { enforce, getClientIp } from './_lib/rate-limit.js';
import { EXIT_REASONS, MAX_COMMENT_CHARS, readExitToken, exitInterviewState, cleanExitAnswer, recordExitAnswer } from './_lib/exitInterview.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from './_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  // Answers are only accepted from Ivy's own page.
  if (req.method === 'POST' && !requireSameOrigin(req, res)) return;
  try {
    res.setHeader?.('Cache-Control', 'no-store');
    if (await enforce(req, res, [{ key: `exit-link:ip:${getClientIp(req)}`, max: 60, windowSeconds: 60 * 60 }])) return;
    const workspaceId = readExitToken(req.query?.token);
    if (!workspaceId) return notFound(res, 'This link is not valid any more');
    const biz = (await sql`
      SELECT cs.biz_name FROM workspaces w LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id WHERE w.id = ${workspaceId}`).rows[0];
    if (!biz) return notFound(res, 'This link is not valid any more');
    const state = await exitInterviewState(workspaceId);

    if (req.method === 'GET') {
      return ok(res, {
        ok: true,
        business: biz.biz_name || null,
        reasons: EXIT_REASONS,
        maxCommentChars: MAX_COMMENT_CHARS,
        // Nothing to ask (they came back, or already answered): the page
        // says thank you instead of showing the form.
        open: !!state.cancelRef && !state.answered,
        answered: state.answered,
      });
    }

    if (!state.cancelRef) return badRequest(res, 'This plan is active again, so there is nothing to answer. Thank you.');
    let answer;
    try { answer = cleanExitAnswer({ ...(await readBody(req)), skipped: false }); } catch (err) { return badRequest(res, err.message); }
    const out = await recordExitAnswer({ workspaceId, source: 'cancel', channel: 'email', answer });
    return ok(res, { saved: out.saved, already: !!out.already });
  } catch (err) {
    return serverError(res, err);
  }
}
