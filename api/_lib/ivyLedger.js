// Words for the per-turn action ledger (built by ledgerEntry in
// api/_lib/ivyTools.js while claudeReply runs tools).
//
// The ledger is the server's own record of what Ivy's tools did in a turn.
// These helpers turn it into:
//   • the reply when the model ran tools but never wrote a final answer
//     (ledgerReply), so finished work is reported instead of thrown away;
//   • the reply when the AI service failed after some tools had already run
//     (ledgerFailureReply), which says exactly what was done and never
//     implies that nothing happened;
//   • the compact note appended to Ivy's past messages in the history the
//     model sees (ledgerHistoryNote), so a later turn can neither forget nor
//     deny what she did.
// Pure functions: no database, no model.

const STATUSES = new Set(['done', 'waiting', 'failed', 'skipped']);
const MAX_STORED = 40;

// Keeps only well-formed entries, bounded, for storage and for the client.
export function cleanLedger(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e === 'object' && STATUSES.has(e.status) && typeof e.summary === 'string')
    .slice(0, MAX_STORED)
    .map((e) => ({
      tool: String(e.tool || '').slice(0, 60),
      status: e.status,
      ok: e.status === 'done',
      summary: e.summary.slice(0, 600),
      ...(e.error ? { error: String(e.error).slice(0, 300) } : {}),
      ...(Array.isArray(e.warnings) && e.warnings.length ? { warnings: e.warnings.slice(0, 5).map((w) => String(w).slice(0, 200)) } : {}),
    }));
}

export const doneEntries = (l) => (Array.isArray(l) ? l.filter((e) => e.status === 'done') : []);
export const waitingEntries = (l) => (Array.isArray(l) ? l.filter((e) => e.status === 'waiting') : []);
export const failedEntries = (l) => (Array.isArray(l) ? l.filter((e) => e.status === 'failed') : []);
export const hasCompletedWrites = (l) => doneEntries(l).length > 0;

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const firstLine = (s) => oneLine(String(s || '').split('\n')[0]);
const sentence = (s) => { const t = oneLine(s).replace(/[.\s]+$/, ''); return t ? `${t}.` : ''; };

function bullets(entries, render) {
  return entries.map((e) => `- ${render(e)}`).join('\n');
}

function doneLine(e) {
  const w = Array.isArray(e.warnings) && e.warnings.length ? ` One thing to check: ${e.warnings.map(sentence).join(' ')}` : '';
  return `${sentence(e.summary)}${w}`;
}
const waitingLine = (e) => sentence(firstLine(e.summary));
const failedLine = (e) => `${sentence(e.summary).replace(/\.$/, '')}: ${sentence(e.error || 'it did not go through')}`;

// The body shared by both replies: what is done, waiting and failed.
function ledgerSections(ledger) {
  const parts = [];
  const done = doneEntries(ledger), waiting = waitingEntries(ledger), failed = failedEntries(ledger);
  if (waiting.length) {
    parts.push(`Waiting for you to tap Approve (nothing has happened yet):\n${bullets(waiting, waitingLine)}`);
  }
  if (failed.length) parts.push(`Didn't work:\n${bullets(failed, failedLine)}`);
  return { done, waiting, failed, parts };
}

// The reply for a turn whose tools ran but whose model never wrote a final
// answer (the time budget ran out, or the answer came back empty). Returns
// null when the ledger has nothing to report.
export function ledgerReply(ledger) {
  const { done, waiting, failed, parts } = ledgerSections(ledger);
  if (!done.length && !waiting.length && !failed.length) return null;
  const out = [];
  if (done.length) out.push(`Done:\n${bullets(done, doneLine)}`);
  out.push(...parts);
  if (!done.length && !waiting.length) out.push('Nothing was changed.');
  return out.join('\n\n');
}

// The reply when the AI service failed partway through a turn. `reason` is
// the owner-readable cause (userFacingReason). Only claims "nothing was
// changed" when no action completed.
export function ledgerFailureReply(ledger, reason) {
  const { done, waiting, parts } = ledgerSections(ledger);
  const why = reason ? ` (${oneLine(reason)})` : '';
  if (done.length) {
    const out = [`I hit a problem before I could finish my answer${why}. Before that I already did this:\n${bullets(done, doneLine)}`];
    out.push(...parts);
    out.push("Nothing else was changed. Tell me what's still left rather than sending the whole request again, so nothing gets done twice.");
    return out.join('\n\n');
  }
  if (waiting.length) {
    const out = [`I hit a problem before I could finish my answer${why}. Nothing has been changed yet.`];
    out.push(...parts);
    return out.join('\n\n');
  }
  return null;
}

// "[What Ivy actually did this turn (from the server log): ...]" for the
// history the model sees. Compact and capped; null when there is nothing.
export function ledgerHistoryNote(actions, maxChars = 500) {
  const list = cleanLedger(actions);
  if (!list.length) return null;
  const label = { done: 'DONE', waiting: 'WAITING FOR APPROVAL (not done unless a later message says it ran)', failed: 'FAILED', skipped: 'SKIPPED BY OWNER' };
  const items = list.map((e) => {
    let t = `${label[e.status]}: ${firstLine(e.summary).slice(0, 160)}`;
    if (e.status === 'failed' && e.error) t += ` (${oneLine(e.error).slice(0, 100)})`;
    if (e.warnings?.length) t += ` (warning: ${oneLine(e.warnings[0]).slice(0, 100)})`;
    return t;
  });
  const head = '[What Ivy actually did this turn (from the server log): ';
  let body = '';
  for (const it of items) {
    const next = body ? `${body}; ${it}` : it;
    if (head.length + next.length + 1 > maxChars) { body = body ? `${body}; and more` : it.slice(0, maxChars - head.length - 2); break; }
    body = next;
  }
  return `${head}${body}]`;
}
