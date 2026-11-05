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
import { APP_WRITE_TOOLS } from './ivyAppTools.js';

// Claims and runs one pending row. Returns { claimed:false } when it had
// already run or expired, otherwise { claimed:true, result, text, actions }
// where actions is the one-entry ledger for the chat message that records the
// outcome (see api/_lib/ivyLedger.js).
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
  // The tool has run. Storing its result is bookkeeping: a failure here must
  // not turn a completed action into an error the owner would read as "not
  // done" (and tap again).
  try {
    await sql`
      UPDATE ivy_pending_actions SET result = ${JSON.stringify(result ?? null)}::jsonb
       WHERE id = ${row.id} AND workspace_id = ${workspaceId}`;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ivy approve] could not store the result:', err?.message);
  }
  const failed = !!(result && result.error);
  // Tools that word their own past-tense line from what really happened
  // (api/_lib/ivyAppTools.js): the Done message and ledger use it instead
  // of repeating the approval card's question.
  const doneLine = !failed && APP_WRITE_TOOLS.has(row.tool) && typeof result?.done === 'string' ? result.done : null;
  const warnings = !failed && Array.isArray(result?.warnings) ? result.warnings.filter(Boolean).slice(0, 5).map(String) : [];
  const actions = [{
    tool: row.tool,
    status: failed ? 'failed' : 'done',
    ok: !failed,
    summary: String(doneLine || row.summary || row.tool).slice(0, 600),
    ...(failed ? { error: String(result.error).slice(0, 300) } : {}),
    ...(warnings.length ? { warnings } : {}),
  }];
  let text = failed ? `That didn't work: ${result.error}` : `Done. ${doneLine || row.summary}`;
  // A client list: counts, not the whole approval card again.
  if (!result?.error && row.tool === 'import_clients_from_list') text = clientImportDoneText(result);
  // Appointments added from a photo, or clients from a list: say who still
  // needs an email, with a link to the Clients list filtered to them.
  if (!result?.error && Array.isArray(result?.missing_email) && result.missing_email.length) {
    const names = result.missing_email.map((c) => c.name);
    const n = Math.max(names.length, Number(result.missing_email_count) || 0);
    const shown = n > 5 ? `${names.slice(0, 5).join(', ')} and ${n - 5} more` : names.join(', ');
    text += `\n\n${n === 1 ? '1 client has' : `${n} clients have`} no email yet, so they won't get booking reminders: ${shown}. [Add ${n === 1 ? 'their email' : 'their emails'}](/clients?filter=missing-email)`;
  }
  // New clients with an email can be told about the move when the owner is
  // ready (nothing was sent to them by the import itself).
  if (!result?.error && row.tool === 'import_clients_from_list' && Number(result?.with_email_count) > 0) {
    text += '\n\nWhen you are ready, you can email them your new booking link: [Let them know you moved](/clients?announce=1)';
  }
  // Some of the new clients look like people already in the list.
  if (!result?.error && row.tool === 'import_clients_from_list' && Number(result?.possible_duplicates) > 0) {
    const d = Number(result.possible_duplicates);
    text += `\n\n${d === 1 ? '1 possible duplicate' : `${d} possible duplicates`} to review: [Review them](/clients?duplicates=1)`;
  }
  // The main change happened but a side step did not (an email, a notice):
  // say both, so the owner neither thinks it failed nor that the email went.
  if (warnings.length) text += `\n\nOne thing to check: ${warnings.join(' ')}`;
  return { claimed: true, result, text, actions };
}

function clientImportDoneText(r) {
  const added = Number(r?.added) || 0;
  const skipped = Number(r?.skipped_existing) || 0;
  const problems = Array.isArray(r?.problems) ? r.problems.length : 0;
  let t = `Done. Added ${added} client${added === 1 ? '' : 's'} to your Clients list`;
  if (skipped) t += `, skipped ${skipped} already there`;
  if (problems) t += `, and ${problems} couldn't be added`;
  return `${t}. No emails or texts went out.`;
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
export async function legacyApprovalReply(args) {
  const out = await legacyApprovalTurn(args);
  return out ? out.text : null;
}

// Same as legacyApprovalReply, plus the ledger of what ran, for the chat
// message that records it. Returns null or { text, actions }.
export async function legacyApprovalTurn({ text, sessionId, workspaceId, userId }) {
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
  const actions = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const out = await executePendingAction({ row, workspaceId, userId });
    if (out.claimed) { lines.push(out.text); actions.push(...(out.actions || [])); }
  }
  if (lines.length === 0) return null;
  return { text: lines.join('\n'), actions };
}
