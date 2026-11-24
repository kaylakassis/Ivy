// The exit interview: asking an owner why they are leaving.
//
// Cancelling does not happen inside Ivy (it is Stripe's billing page on the
// website and Apple's settings on iPhone), so Ivy asks afterwards, in three
// places, and stores one answer per cancellation:
//   • in the app, the next time the owner opens it after turning renewal
//     off or after the plan ended (api/me exitInterview.due);
//   • in the "cancelled" and "plan ending" emails, as a link that works
//     without signing in (a signed token, api/exit-interview.js);
//   • before deleting an account (source 'delete').
//
// What is kept: the reasons picked, an optional comment, and a little
// context that is not about any person (how many months they were with Ivy,
// what kind of business, how they paid). The row points at the business
// only while it exists; when an account is deleted the pointer is cleared
// and the answer stays as anonymous feedback.
import crypto from 'node:crypto';
import { sql } from './db.js';

export const EXIT_REASONS = [
  { id: 'too_expensive', label: 'It costs too much' },
  { id: 'not_using', label: 'I was not using it enough' },
  { id: 'too_complicated', label: 'It was too hard to figure out' },
  { id: 'missing_feature', label: 'It is missing something I need' },
  { id: 'switched', label: 'I am using something else' },
  { id: 'not_working', label: 'Things did not work properly' },
  { id: 'business_closed', label: 'I closed or paused my business' },
  { id: 'taking_a_break', label: 'I am taking a break and may be back' },
  { id: 'other', label: 'Something else' },
];
const REASON_IDS = new Set(EXIT_REASONS.map((r) => r.id));
export const MAX_COMMENT_CHARS = 1000;
export const SOURCES = ['cancel', 'delete'];
export const CHANNELS = ['app', 'email'];
export const TOKEN_TTL_DAYS = 45;

// ── what counts as "this cancellation" ──────────────────────────────────
// A cancellation is identified by the date the paid period ends, so an owner
// who comes back and later cancels again is asked again, once.
function cancelRefOf(ws) {
  if (!ws?.subscription_period_end) return null;
  const d = new Date(ws.subscription_period_end);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

// Has this business cancelled a plan it was paying for?
//   renewal turned off (still has access), or the plan ended after being
//   paid for. A free trial that simply ran out is not a cancellation.
function hasCancelled(ws) {
  if (!ws) return false;
  if (ws.cancel_at_period_end && ['active', 'trialing', 'past_due'].includes(ws.subscription_status)) return true;
  if (['cancelled', 'canceled', 'expired'].includes(ws.subscription_status) && ws.subscription_period_end) return true;
  return false;
}

async function loadWorkspace(workspaceId) {
  const { rows } = await sql`
    SELECT w.id, w.created_at, w.business_type, w.subscription_status, w.subscription_source,
           w.subscription_period_end, w.cancel_at_period_end
      FROM workspaces w WHERE w.id = ${workspaceId}`;
  return rows[0] || null;
}

// { due, answered, cancelRef }
//   due:      should the app ask this owner now? (cancelled, and neither
//             answered nor said "not now")
//   answered: a real answer is on file for this cancellation. "Not now" in
//             the app is not an answer, so the email link still asks.
export async function exitInterviewState(workspaceId) {
  const none = { due: false, answered: false, cancelRef: null };
  if (!workspaceId) return none;
  const ws = await loadWorkspace(workspaceId);
  if (!hasCancelled(ws)) return none;
  const cancelRef = cancelRefOf(ws);
  if (!cancelRef) return none;
  const { rows } = await sql`
    SELECT skipped FROM exit_answers WHERE workspace_id = ${workspaceId} AND source = 'cancel' AND cancel_ref = ${cancelRef}`;
  return { due: rows.length === 0, answered: rows.some((r) => !r.skipped), cancelRef };
}

// ── cleaning what comes in ──────────────────────────────────────────────
export function cleanExitAnswer(body) {
  const b = body && typeof body === 'object' ? body : {};
  const skipped = b.skipped === true;
  const reasons = [...new Set((Array.isArray(b.reasons) ? b.reasons : []).map(String).filter((r) => REASON_IDS.has(r)))];
  // Control characters out, whitespace tidied, length capped. It is stored
  // and shown as plain text only.
  const comment = String(b.comment ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, MAX_COMMENT_CHARS);
  if (!skipped && reasons.length === 0 && !comment) throw new Error('Pick a reason or write a few words');
  return { skipped, reasons: skipped ? [] : reasons, comment: skipped ? '' : comment };
}

// Records one answer. For a cancellation there is one row per cancellation:
// a real answer replaces an earlier "not now", and nothing replaces a real
// answer. Returns { saved, replaced }.
export async function recordExitAnswer({ workspaceId, source = 'cancel', channel = 'app', answer }) {
  if (!SOURCES.includes(source) || !CHANNELS.includes(channel)) throw new Error('Unknown source');
  const ws = await loadWorkspace(workspaceId);
  if (!ws) throw new Error('No business');
  const cancelRef = source === 'cancel' ? cancelRefOf(ws) : null;
  if (source === 'cancel' && (!hasCancelled(ws) || !cancelRef)) throw new Error('This plan has not been cancelled');
  const months = Math.max(0, Math.floor((Date.now() - new Date(ws.created_at).getTime()) / (30.44 * 86400e3)));
  const context = {
    months, businessType: ws.business_type || null,
    planSource: ws.subscription_source || (ws.subscription_status === 'trialing' ? 'trial' : null),
  };
  if (source === 'cancel') {
    const prior = (await sql`
      SELECT id, skipped FROM exit_answers WHERE workspace_id = ${workspaceId} AND source = 'cancel' AND cancel_ref = ${cancelRef}
       ORDER BY created_at DESC LIMIT 1`).rows[0];
    if (prior && !prior.skipped) return { saved: false, replaced: false, already: true };
    if (prior && answer.skipped) return { saved: false, replaced: false, already: true };
    if (prior) {
      await sql`
        UPDATE exit_answers SET skipped = FALSE, reasons = ${answer.reasons}, comment = ${answer.comment || null},
               channel = ${channel}, created_at = NOW()
         WHERE id = ${prior.id}`;
      return { saved: true, replaced: true };
    }
  }
  await sql`
    INSERT INTO exit_answers (workspace_id, source, channel, cancel_ref, skipped, reasons, comment, months_with_ivy, business_type, plan_source)
    VALUES (${workspaceId}, ${source}, ${channel}, ${cancelRef}, ${answer.skipped}, ${answer.reasons}, ${answer.comment || null},
            ${context.months}, ${context.businessType}, ${context.planSource})`;
  return { saved: true, replaced: false };
}

// ── the link in the emails ──────────────────────────────────────────────
// "<workspace id>.<expiry>.<signature>": lets the owner answer from the
// email without signing in, for this business only, for 45 days.
function sign(workspaceId, exp) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Signing secret is not set');
  return crypto.createHmac('sha256', secret).update(`exit|${workspaceId}|${exp}`).digest('hex');
}
export function makeExitToken(workspaceId, nowMs = Date.now()) {
  const exp = nowMs + TOKEN_TTL_DAYS * 86400e3;
  return `${workspaceId}.${exp}.${sign(workspaceId, exp)}`;
}
export function readExitToken(token, nowMs = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [workspaceId, exp, sig] = parts;
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !/^\d{10,16}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  if (Number(exp) <= nowMs) return null;
  let want;
  try { want = sign(workspaceId, exp); } catch { return null; }
  const a = Buffer.from(want, 'hex'); const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return workspaceId;
}
// The address for the email button, or null when it cannot be made (the
// email then simply has no button).
export function exitLink(workspaceId, baseUrl) {
  try { return `${String(baseUrl || '').replace(/\/+$/, '')}/exit/${makeExitToken(workspaceId)}`; } catch { return null; }
}

// ── what the operator sees ──────────────────────────────────────────────
export const WINDOWS = [30, 90, 365];
export async function exitSummary({ days = 90 } = {}) {
  const win = WINDOWS.includes(Number(days)) ? Number(days) : 90;
  const { rows } = await sql`
    SELECT e.id, e.source, e.channel, e.skipped, e.reasons, e.comment, e.months_with_ivy, e.business_type, e.plan_source, e.created_at,
           cs.biz_name
      FROM exit_answers e
      LEFT JOIN calendar_settings cs ON cs.workspace_id = e.workspace_id
     WHERE e.created_at > NOW() - (${String(win)} || ' days')::interval
     ORDER BY e.created_at DESC
     LIMIT 1000`;
  const answered = rows.filter((r) => !r.skipped);
  const counts = Object.fromEntries(EXIT_REASONS.map((r) => [r.id, 0]));
  for (const r of answered) for (const id of r.reasons || []) if (id in counts) counts[id] += 1;
  return {
    days: win,
    asked: rows.length,
    answered: answered.length,
    skipped: rows.length - answered.length,
    reasons: EXIT_REASONS.map((r) => ({ id: r.id, label: r.label, count: counts[r.id], pct: answered.length ? Math.round((counts[r.id] / answered.length) * 100) : 0 }))
      .sort((a, b) => b.count - a.count),
    answers: answered.slice(0, 200).map((r) => ({
      id: r.id, at: r.created_at, source: r.source, channel: r.channel,
      reasons: (r.reasons || []).map((id) => EXIT_REASONS.find((x) => x.id === id)?.label || id),
      comment: r.comment || null,
      monthsWithIvy: r.months_with_ivy, businessType: r.business_type, planSource: r.plan_source,
      // The business name only while the account still exists.
      business: r.biz_name || null,
    })),
  };
}
