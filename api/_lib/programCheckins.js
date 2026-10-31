// Programs: check-ins. General-purpose forms the owner builds (no preset
// fields) that a member fills in once per period: every day, weekly on a
// chosen weekday, or once. A member may edit their answers until the
// period ends. Answers are private: only the member who wrote them and
// the program's owner can ever read them.
import { sql } from './db.js';
import { zonedTimeToUtcMs, zonedParts } from './tz.js';
import { localDay } from './programEngagement.js';
import { safeBlobUrl } from './programCommunity.js';

export const QUESTION_TYPES = ['short', 'long', 'number', 'scale', 'yesno', 'choice', 'photo'];
export const MAX_QUESTIONS = 10;
export const MAX_OPTIONS = 10;
export const MAX_REPLIES = 20;
export const FREQUENCIES = ['daily', 'weekly', 'once'];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekdayOf = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const qid = () => Math.random().toString(36).slice(2, 10);

// Owner input → { value: { title, frequency, weekday, questions, remind } } or { error }.
export function cleanForm(body, current = null) {
  const title = String(body.title ?? current?.title ?? '').trim().slice(0, 140);
  if (!title) return { error: 'Give the check-in a title.' };
  const frequency = String(body.frequency ?? current?.frequency ?? 'weekly');
  if (!FREQUENCIES.includes(frequency)) return { error: 'Choose daily, weekly or one-off.' };
  let weekday = null;
  if (frequency === 'weekly') {
    weekday = Math.round(Number(body.weekday ?? current?.weekday ?? 1));
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: 'Pick the day of the week it is due.' };
  }
  const raw = body.questions ?? current?.questions ?? [];
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Add at least one question.' };
  if (raw.length > MAX_QUESTIONS) return { error: `Up to ${MAX_QUESTIONS} questions per check-in.` };
  const seen = new Set();
  const questions = [];
  for (const q of raw) {
    const type = String(q?.type || '');
    if (!QUESTION_TYPES.includes(type)) return { error: 'One of the questions has an unknown type.' };
    const label = String(q?.label || '').trim().slice(0, 300);
    if (!label) return { error: 'Every question needs a label.' };
    let id = /^[a-z0-9]{4,16}$/.test(String(q?.id || '')) ? String(q.id) : qid();
    while (seen.has(id)) id = qid();
    seen.add(id);
    const out = { id, type, label, required: !!q.required };
    if (type === 'choice') {
      const opts = (Array.isArray(q.options) ? q.options : []).map((o) => String(o || '').trim().slice(0, 100)).filter(Boolean);
      const uniq = [...new Set(opts)];
      if (uniq.length < 2) return { error: `Give "${label}" at least two choices.` };
      if (uniq.length > MAX_OPTIONS) return { error: `Up to ${MAX_OPTIONS} choices per question.` };
      out.options = uniq;
    }
    questions.push(out);
  }
  const remind = body.remind !== undefined ? !!body.remind : (current ? !!current.remind : true);
  return { value: { title, frequency, weekday, questions, remind } };
}

export function serializeForm(f, extra = {}) {
  return {
    id: f.id, title: f.title, frequency: f.frequency, weekday: f.weekday == null ? null : Number(f.weekday),
    questions: Array.isArray(f.questions) ? f.questions : [], remind: !!f.remind, createdAt: f.created_at, ...extra,
  };
}

// The period a submission belongs to right now, in the business's timezone.
// { key, startsAt, endsAt (null = never), dueToday }
export function currentPeriod(form, tz, now = new Date()) {
  const today = localDay(tz, now);
  if (form.frequency === 'daily') {
    return { key: today, startsAt: new Date(zonedTimeToUtcMs(today, 0, tz)), endsAt: new Date(zonedTimeToUtcMs(addDays(today, 1), 0, tz)), dueToday: true };
  }
  if (form.frequency === 'weekly') {
    const wd = Number(form.weekday ?? 1);
    const back = (weekdayOf(today) - wd + 7) % 7;
    const start = addDays(today, -back);
    return { key: start, startsAt: new Date(zonedTimeToUtcMs(start, 0, tz)), endsAt: new Date(zonedTimeToUtcMs(addDays(start, 7), 0, tz)), dueToday: back === 0 };
  }
  return { key: 'once', startsAt: new Date(form.created_at || now), endsAt: null, dueToday: false };
}

// Local hour of `now` in tz (for "remind from 9am").
export const localMinutes = (tz, now = new Date()) => zonedParts(tz, now).minutes;

// Member answers → { value } (keyed by question id) or { error }.
// Photos must be uploads in a workspace the member could have written to.
export function cleanAnswers(questions, raw, uploadWorkspaces) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const q of questions || []) {
    const v = src[q.id];
    const empty = v == null || v === '' || (typeof v === 'string' && !v.trim());
    if (empty) {
      if (q.required) return { error: `Please answer "${q.label}".` };
      continue;
    }
    if (q.type === 'short' || q.type === 'long') {
      const max = q.type === 'short' ? 300 : 5000;
      out[q.id] = String(v).trim().slice(0, max);
    } else if (q.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || Math.abs(n) > 1e9) return { error: `"${q.label}" needs a number.` };
      out[q.id] = Math.round(n * 1000) / 1000;
    } else if (q.type === 'scale') {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 1 || n > 10) return { error: `"${q.label}" is a 1 to 10 scale.` };
      out[q.id] = n;
    } else if (q.type === 'yesno') {
      if (v === true || v === 'yes' || v === 'true') out[q.id] = true;
      else if (v === false || v === 'no' || v === 'false') out[q.id] = false;
      else return { error: `"${q.label}" is a yes or no question.` };
    } else if (q.type === 'choice') {
      const s = String(v);
      if (!(q.options || []).includes(s)) return { error: `Pick one of the choices for "${q.label}".` };
      out[q.id] = s;
    } else if (q.type === 'photo') {
      const url = safeBlobUrl(String(v), uploadWorkspaces);
      if (!url) return { error: 'That photo could not be used. Please upload it again.' };
      out[q.id] = url;
    }
  }
  if (!Object.keys(out).length) return { error: 'Answer at least one question.' };
  return { value: out };
}

export function serializeResponse(r, { form = null, includeMember = false } = {}) {
  const out = {
    id: r.id, formId: r.form_id, formTitle: form?.title || r.form_title || null, periodKey: r.period_key,
    answers: r.answers || {}, replies: Array.isArray(r.replies) ? r.replies : [],
    submittedAt: r.submitted_at, updatedAt: r.updated_at,
  };
  if (includeMember) { out.clientId = r.client_id; out.memberName = r.member_name || 'Member'; out.unreadByMember = !!(out.replies.length && (!r.replies_seen_at || new Date(r.replies_seen_at) < new Date(out.replies.at(-1).at))); }
  return out;
}

export async function loadForms(programId, workspaceId, { includeArchived = false } = {}) {
  return (await sql`SELECT * FROM program_checkin_forms WHERE program_id = ${programId} AND workspace_id = ${workspaceId}
                     AND (${includeArchived} OR archived_at IS NULL) ORDER BY created_at ASC`).rows;
}
