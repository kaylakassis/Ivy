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
// For an owner whose free trial ran out without picking a plan: "what
// stopped you from subscribing?". Mostly the same, minus the two that only
// make sense for someone who was paying, plus two that fit a trial.
export const TRIAL_REASONS = [
  { id: 'too_expensive', label: 'It costs too much' },
  { id: 'not_enough_time', label: 'I did not have time to try it properly' },
  { id: 'too_complicated', label: 'It was too hard to figure out' },
  { id: 'missing_feature', label: 'It is missing something I need' },
  { id: 'switched', label: 'I am using something else' },
  { id: 'not_working', label: 'Things did not work properly' },
  { id: 'business_closed', label: 'I closed or paused my business' },
  { id: 'still_deciding', label: 'I am still deciding' },
  { id: 'other', label: 'Something else' },
];
const ALL_REASONS = [...EXIT_REASONS, ...TRIAL_REASONS.filter((t) => !EXIT_REASONS.some((e) => e.id === t.id))];
const REASON_IDS = new Set(ALL_REASONS.map((r) => r.id));
export const reasonsFor = (kind) => (kind === 'trial' ? TRIAL_REASONS : EXIT_REASONS);
const labelOf = (id) => ALL_REASONS.find((x) => x.id === id)?.label || id;
export const MAX_COMMENT_CHARS = 1000;
// cancel: turned renewal off, or a paid plan ended. trial: a free trial ran
// out and no plan was picked. delete: deleting the account.
export const SOURCES = ['cancel', 'trial', 'delete'];
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
//   paid for. A free trial that simply ran out is not a cancellation; that
//   is hasTrialEnded below, asked differently.
function hasCancelled(ws) {
  if (!ws) return false;
  if (ws.cancel_at_period_end && ['active', 'trialing', 'past_due'].includes(ws.subscription_status)) return true;
  if (['cancelled', 'canceled', 'expired'].includes(ws.subscription_status) && ws.subscription_period_end) return true;
  return false;
}

// A free trial that ran out with no plan picked (and no complimentary
// access): the same test the paywall uses for "your trial has ended".
function hasTrialEnded(ws, now = Date.now()) {
  if (!ws || ws.subscription_status !== 'trialing' || ws.cancel_at_period_end) return false;
  if (ws.comp_until && new Date(ws.comp_until).getTime() > now) return false;
  const end = ws.trial_ends_at ? new Date(ws.trial_ends_at).getTime() : null;
  return !!end && end <= now;
}
function trialRefOf(ws) {
  const d = ws?.trial_ends_at ? new Date(ws.trial_ends_at) : null;
  return d && Number.isFinite(d.getTime()) ? `trial:${d.toISOString().slice(0, 10)}` : null;
}
// Which question applies to this business right now, and its reference
// (one answer per reference): { kind: 'cancel' | 'trial' | null, ref }.
function leavingKind(ws) {
  if (hasCancelled(ws) && cancelRefOf(ws)) return { kind: 'cancel', ref: cancelRefOf(ws) };
  if (hasTrialEnded(ws) && trialRefOf(ws)) return { kind: 'trial', ref: trialRefOf(ws) };
  return { kind: null, ref: null };
}

async function loadWorkspace(workspaceId) {
  const { rows } = await sql`
    SELECT w.id, w.created_at, w.business_type, w.subscription_status, w.subscription_source,
           w.subscription_period_end, w.cancel_at_period_end, w.trial_ends_at, w.comp_until
      FROM workspaces w WHERE w.id = ${workspaceId}`;
  return rows[0] || null;
}

// { kind, due, answered, cancelRef }
//   kind:     'cancel' (cancelled a plan), 'trial' (free trial ran out), or
//             null (nothing to ask).
//   due:      nothing on file yet for this cancellation or trial: neither
//             an answer nor a "not now". For a cancellation the app asks by
//             itself when this is true; for a trial it only offers a link on
//             the paywall, never a pop-up over the subscribe screen.
//   answered: a real answer is on file. "Not now" is not an answer, so the
//             email link still asks.
export async function exitInterviewState(workspaceId) {
  const none = { kind: null, due: false, answered: false, cancelRef: null };
  if (!workspaceId) return none;
  const ws = await loadWorkspace(workspaceId);
  const { kind, ref } = leavingKind(ws);
  if (!kind) return none;
  const { rows } = await sql`
    SELECT skipped FROM exit_answers WHERE workspace_id = ${workspaceId} AND source = ${kind} AND cancel_ref = ${ref}`;
  return { kind, due: rows.length === 0, answered: rows.some((r) => !r.skipped), cancelRef: ref };
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

// Records one answer. source 'leaving' means "whichever applies": the
// server works out whether this business cancelled or its trial ran out
// (the caller cannot choose). There is one row per cancellation or trial: a
// real answer replaces an earlier "not now", and nothing replaces a real
// answer. Returns { saved, replaced, source }.
export async function recordExitAnswer({ workspaceId, source = 'leaving', channel = 'app', answer }) {
  if (!['leaving', 'delete'].includes(source) || !CHANNELS.includes(channel)) throw new Error('Unknown source');
  const ws = await loadWorkspace(workspaceId);
  if (!ws) throw new Error('No business');
  let cancelRef = null;
  if (source === 'leaving') {
    const lk = leavingKind(ws);
    if (!lk.kind) throw new Error('There is nothing to answer: this plan is running');
    source = lk.kind; cancelRef = lk.ref;
  }
  const months = Math.max(0, Math.floor((Date.now() - new Date(ws.created_at).getTime()) / (30.44 * 86400e3)));
  const context = {
    months, businessType: ws.business_type || null,
    planSource: source === 'trial' ? 'trial' : (ws.subscription_source || (ws.subscription_status === 'trialing' ? 'trial' : null)),
  };
  if (source !== 'delete') {
    const prior = (await sql`
      SELECT id, skipped FROM exit_answers WHERE workspace_id = ${workspaceId} AND source = ${source} AND cancel_ref = ${cancelRef}
       ORDER BY created_at DESC LIMIT 1`).rows[0];
    if (prior && !prior.skipped) return { saved: false, replaced: false, already: true, source };
    if (prior && answer.skipped) return { saved: false, replaced: false, already: true, source };
    if (prior) {
      await sql`
        UPDATE exit_answers SET skipped = FALSE, reasons = ${answer.reasons}, comment = ${answer.comment || null},
               channel = ${channel}, created_at = NOW()
         WHERE id = ${prior.id}`;
      return { saved: true, replaced: true, source };
    }
  }
  await sql`
    INSERT INTO exit_answers (workspace_id, source, channel, cancel_ref, skipped, reasons, comment, months_with_ivy, business_type, plan_source)
    VALUES (${workspaceId}, ${source}, ${channel}, ${cancelRef}, ${answer.skipped}, ${answer.reasons}, ${answer.comment || null},
            ${context.months}, ${context.businessType}, ${context.planSource})`;
  return { saved: true, replaced: false, source };
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
// source: 'all' (default), or one of SOURCES to look at one group alone.
export async function exitSummary({ days = 90, source = 'all' } = {}) {
  const win = WINDOWS.includes(Number(days)) ? Number(days) : 90;
  const only = SOURCES.includes(source) ? source : null;
  const { rows: all } = await sql`
    SELECT e.id, e.source, e.channel, e.skipped, e.reasons, e.comment, e.months_with_ivy, e.business_type, e.plan_source, e.created_at,
           cs.biz_name
      FROM exit_answers e
      LEFT JOIN calendar_settings cs ON cs.workspace_id = e.workspace_id
     WHERE e.created_at > NOW() - (${String(win)} || ' days')::interval
     ORDER BY e.created_at DESC
     LIMIT 2000`;
  const bySource = Object.fromEntries(SOURCES.map((x) => [x, all.filter((r) => r.source === x && !r.skipped).length]));
  const rows = only ? all.filter((r) => r.source === only) : all;
  const answered = rows.filter((r) => !r.skipped);
  const list = only === 'trial' ? TRIAL_REASONS : only ? EXIT_REASONS : ALL_REASONS;
  const counts = Object.fromEntries(ALL_REASONS.map((r) => [r.id, 0]));
  for (const r of answered) for (const id of r.reasons || []) if (id in counts) counts[id] += 1;
  return {
    days: win,
    source: only || 'all',
    bySource,
    asked: rows.length,
    answered: answered.length,
    skipped: rows.length - answered.length,
    reasons: list.map((r) => ({ id: r.id, label: r.label, count: counts[r.id], pct: answered.length ? Math.round((counts[r.id] / answered.length) * 100) : 0 }))
      .sort((a, b) => b.count - a.count),
    answers: answered.slice(0, 200).map((r) => ({
      id: r.id, at: r.created_at, source: r.source, channel: r.channel,
      reasons: (r.reasons || []).map(labelOf),
      comment: r.comment || null,
      monthsWithIvy: r.months_with_ivy, businessType: r.business_type, planSource: r.plan_source,
      // The business name only while the account still exists.
      business: r.biz_name || null,
    })),
  };
}
