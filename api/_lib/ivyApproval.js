// Running an Ivy action the owner approved. Shared by the approval card
// endpoint (api/ivy/approve.js) and the compatibility path for iPhone builds
// already in the App Store (legacyApprovalReply below).
//
// A row in ivy_pending_actions is claimed and marked executed in one
// statement, so however the approval arrives (a tap, a second tab, a retry)
// the stored call runs at most once, with the arguments the server stored,
// never anything the model says afterwards.
import { sql } from './db.js';
import { runApprovedTool } from './ivyTools.js';

// Claims and runs one pending row. Returns { claimed:false } when it had
// already run or expired, otherwise { claimed:true, result, text }.
export async function executePendingAction({ row, workspaceId, userId }) {
  const claimed = await sql`
    UPDATE ivy_pending_actions
       SET approved_at = COALESCE(approved_at, NOW()), executed_at = NOW()
     WHERE id = ${row.id} AND workspace_id = ${workspaceId}
       AND executed_at IS NULL AND expires_at > NOW()
     RETURNING id`;
  if (claimed.rows.length === 0) return { claimed: false };

  let result;
  try {
    result = await runApprovedTool(row.tool, row.args || {}, { workspaceId, userId, sessionId: row.session_id });
  } catch (err) {
    result = { error: err?.message || String(err) };
  }
  await sql`
    UPDATE ivy_pending_actions SET result = ${JSON.stringify(result ?? null)}::jsonb
     WHERE id = ${row.id} AND workspace_id = ${workspaceId}`;
  const text = result && result.error ? `That didn't work: ${result.error}` : `Done. ${row.summary}`;
  return { claimed: true, result, text };
}

// iPhone builds released before server-side approval approve a card by
// sending this exact message as the owner. Newer builds call
// /api/ivy/approve instead and never send it.
export const LEGACY_APPROVAL_TEXT = 'Yes, go ahead and do it.';

// When the owner's own message is exactly the legacy approval text, run the
// actions still waiting in THIS chat (unexpired, so from the last 15
// minutes) and return the reply text, with no model call. Returns null for
// any other message. The trigger is the owner's typed or tapped message, never
// text from client data or tool results, so it cannot be injected.
export async function legacyApprovalReply({ text, sessionId, workspaceId, userId }) {
  if (!sessionId || String(text || '').trim() !== LEGACY_APPROVAL_TEXT) return null;
  const { rows } = await sql`
    SELECT id, session_id, tool, args, summary
      FROM ivy_pending_actions
     WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
       AND executed_at IS NULL AND expires_at > NOW()
     ORDER BY created_at ASC
     LIMIT 10`;
  if (rows.length === 0) return null;
  const lines = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const out = await executePendingAction({ row, workspaceId, userId });
    if (out.claimed) lines.push(out.text);
  }
  if (lines.length === 0) return null;
  return lines.join('\n');
}
