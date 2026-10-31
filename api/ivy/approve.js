// /api/ivy/approve - the owner's tap on an approval card.
//
//   POST   { id } → runs the recorded tool call once, with the arguments the
//                   server stored when the model asked for it. Returns
//                   { ok, result, message } where message is the Ivy chat
//                   message that records the outcome.
//   DELETE { id } → declines it: the row expires now, so it can never run,
//                   and the chat records that it was skipped.
//
// This is the ONLY path that executes a sensitive Ivy tool. The model's call
// was parked in ivy_pending_actions by executeIvyTool (api/_lib/ivyTools.js);
// nothing the model says (including a "confirm" argument) can run it. The row
// is looked up by id AND the caller's workspace, must be unexpired, and is
// marked executed in the same statement that claims it, so a double tap or
// two tabs cannot run it twice.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { executePendingAction } from '../_lib/ivyApproval.js';
import { serializeMessage, stripInlineMarkdown, sanitizeIvyReply } from '../_lib/ivy.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST' && req.method !== 'DELETE') return methodNotAllowed(res, ['POST', 'DELETE']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    // Same gate as the rest of /api/ivy: a helper-only account gets the 403
    // ensureWorkspace raises (serverError turns it into a plain 403).
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req).catch(() => ({}));
    const id = String(body?.id || req.query?.id || '').trim();
    if (!UUID_RE.test(id)) return badRequest(res, 'id is required');

    const found = await sql`
      SELECT id, session_id, tool, args, summary, expires_at, executed_at
        FROM ivy_pending_actions
       WHERE id = ${id} AND workspace_id = ${workspaceId}`;
    const row = found.rows[0];
    if (!row) return notFound(res, 'Nothing to approve');

    if (req.method === 'DELETE') {
      if (row.executed_at) return conflict(res, 'This action has already run.');
      await sql`
        UPDATE ivy_pending_actions SET expires_at = LEAST(expires_at, NOW())
         WHERE id = ${id} AND workspace_id = ${workspaceId} AND executed_at IS NULL`;
      const message = await appendIvyMessage(workspaceId, row.session_id, `Okay, skipped: ${row.summary}. Nothing was done.`);
      return ok(res, { ok: true, dismissed: true, message });
    }

    if (row.executed_at) return conflict(res, 'This action has already run.');
    if (new Date(row.expires_at).getTime() <= Date.now()) return conflict(res, 'This approval has expired. Ask Ivy again if you still want it.');

    // Claim-and-run is shared with the legacy path (api/_lib/ivyApproval.js):
    // whoever claims the row runs it; a second tap, a retry or another tab
    // gets nothing and answers 409.
    const out = await executePendingAction({ row, workspaceId, userId: user.id });
    if (!out.claimed) return conflict(res, 'This action has already run or expired.');
    const { result, text } = out;
    const message = await appendIvyMessage(workspaceId, row.session_id, text);
    return ok(res, { ok: !(result && result.error), result, message });
  } catch (err) {
    return serverError(res, err);
  }
}

function conflict(res, message) {
  return res.status(409).json({ error: message });
}

// Writes the outcome into the chat the action came from, the same way
// finishTurn stores Ivy's replies (api/_lib/ivyTurn.js), so the owner sees
// it and the model's next turn knows the action ran (or was skipped).
async function appendIvyMessage(workspaceId, sessionId, text) {
  if (!sessionId) return null;
  const owned = await sql`SELECT id FROM ivy_sessions WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`;
  if (owned.rows.length === 0) return null;
  const clean = sanitizeIvyReply(text);
  const ins = await sql`
    INSERT INTO ivy_messages (session_id, role, text)
    VALUES (${sessionId}, 'ivy', ${clean})
    RETURNING *`;
  await sql`
    UPDATE ivy_sessions
       SET last_message_at = NOW(), last_message_preview = ${stripInlineMarkdown(clean).slice(0, 120)}, updated_at = NOW()
     WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`;
  return serializeMessage(ins.rows[0]);
}
