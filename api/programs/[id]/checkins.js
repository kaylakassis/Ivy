// Check-ins of a program.
//
// Member (enrolled):
//   GET                                  → the forms, each with this period's
//                                          status and MY answers, plus my
//                                          recent check-ins with the coach's
//                                          replies (marks replies read)
//   POST { formId, answers }             → submit, or edit this period's
//                                          answers until the period ends
// Owner:
//   GET  ?formId=&clientId=&before=      → forms + the responses inbox (50 a
//                                          page, newest first) + members
//   GET  ?view=trend&clientId=           → one member's number / scale answers
//                                          over time, per question
//   POST { action: 'create-form', title, frequency, weekday?, questions, remind? }
//   POST { action: 'reply', responseId, body } → private reply (notifies the member)
//   PATCH { formId, ...fields }          → edit a form
//   DELETE ?formId=                      → archive (answers are kept)
//
// Privacy: a member only ever reads rows WHERE client_id = their own; the
// owner reads only their own program's. Anyone else gets a 404.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { isUuid } from '../../_lib/programs.js';
import { communityAccess, uploadWorkspacesFor } from '../../_lib/programCommunity.js';
import { workspaceTimezone } from '../../_lib/programCommerce.js';
import {
  cleanForm, serializeForm, currentPeriod, cleanAnswers, serializeResponse, loadForms, MAX_REPLIES,
} from '../../_lib/programCheckins.js';
import { notifyCheckinReply, notifyOwnerCheckin } from '../../_lib/programCheckinNotify.js';
import { badRequest, created, forbidden, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

const MAX_FORMS = 20;
const PAGE = 50;

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const programId = String(req.query.id || '');
    const access = await communityAccess(user, programId);
    if (!access) return notFound(res, 'Program not found');
    const { program } = access;
    const isOwner = access.role === 'owner';
    const wid = program.workspace_id;
    const tz = await workspaceTimezone(wid);
    const now = new Date();

    if (req.method === 'GET') {
      const forms = await loadForms(programId, wid);
      if (!isOwner) {
        const cid = access.clientId;
        const mine = (await sql`
          SELECT r.*, f.title AS form_title FROM program_checkin_responses r JOIN program_checkin_forms f ON f.id = r.form_id
           WHERE r.program_id = ${programId} AND r.client_id = ${cid} ORDER BY r.submitted_at DESC LIMIT 60`).rows;
        const out = forms.map((f) => {
          const period = currentPeriod(f, tz, now);
          const cur = mine.find((r) => r.form_id === f.id && r.period_key === period.key) || null;
          return serializeForm(f, {
            period: { key: period.key, endsAt: period.endsAt, dueToday: period.dueToday },
            status: cur ? 'done' : 'due', current: cur ? serializeResponse(cur, { form: f }) : null,
          });
        });
        const unread = mine.filter((r) => Array.isArray(r.replies) && r.replies.length && (!r.replies_seen_at || new Date(r.replies_seen_at) < new Date(r.replies.at(-1).at))).length;
        if (unread) await sql`UPDATE program_checkin_responses SET replies_seen_at = NOW() WHERE program_id = ${programId} AND client_id = ${cid} AND jsonb_array_length(replies) > 0`;
        return ok(res, { role: 'member', forms: out, history: mine.map((r) => serializeResponse(r)), unreadReplies: unread, timezone: tz });
      }
      // Owner.
      const formsOut = forms.map((f) => serializeForm(f));
      const members = (await sql`
        SELECT DISTINCT ON (e.client_id) e.client_id, COALESCE(mp.display_name, c.name) AS name
          FROM program_enrollments e JOIN clients c ON c.id = e.client_id AND c.workspace_id = e.workspace_id
          LEFT JOIN program_member_profiles mp ON mp.workspace_id = c.workspace_id AND mp.user_id = c.user_id
         WHERE e.program_id = ${programId} AND e.workspace_id = ${wid}
         ORDER BY e.client_id, e.granted_at DESC`).rows.map((m) => ({ clientId: m.client_id, name: m.name || 'Member' }));
      const clientId = req.query.clientId && isUuid(String(req.query.clientId)) ? String(req.query.clientId) : null;
      if (req.query.view === 'trend') {
        if (!clientId) return badRequest(res, 'Pick a member.');
        const rows = (await sql`SELECT form_id, period_key, answers, submitted_at FROM program_checkin_responses
                                 WHERE program_id = ${programId} AND workspace_id = ${wid} AND client_id = ${clientId}
                                 ORDER BY submitted_at ASC LIMIT 500`).rows;
        const series = [];
        for (const f of await loadForms(programId, wid, { includeArchived: true })) {
          for (const q of (f.questions || []).filter((x) => x.type === 'number' || x.type === 'scale')) {
            const points = rows.filter((r) => r.form_id === f.id && typeof r.answers?.[q.id] === 'number')
              .map((r) => ({ at: r.submitted_at, period: r.period_key, value: r.answers[q.id] }));
            if (points.length) series.push({ formId: f.id, formTitle: f.title, questionId: q.id, label: q.label, type: q.type, points });
          }
        }
        return ok(res, { clientId, series });
      }
      const formId = req.query.formId && isUuid(String(req.query.formId)) ? String(req.query.formId) : null;
      const before = req.query.before && !Number.isNaN(new Date(String(req.query.before)).getTime()) ? new Date(String(req.query.before)).toISOString() : null;
      const rows = (await sql`
        SELECT r.*, f.title AS form_title, COALESCE(mp.display_name, c.name) AS member_name
          FROM program_checkin_responses r
          JOIN program_checkin_forms f ON f.id = r.form_id
          JOIN clients c ON c.id = r.client_id AND c.workspace_id = r.workspace_id
          LEFT JOIN program_member_profiles mp ON mp.workspace_id = c.workspace_id AND mp.user_id = c.user_id
         WHERE r.program_id = ${programId} AND r.workspace_id = ${wid}
           AND (${formId}::uuid IS NULL OR r.form_id = ${formId}::uuid)
           AND (${clientId}::uuid IS NULL OR r.client_id = ${clientId}::uuid)
           AND (${before}::timestamptz IS NULL OR r.submitted_at < ${before}::timestamptz)
         ORDER BY r.submitted_at DESC LIMIT ${PAGE + 1}`).rows;
      const page = rows.slice(0, PAGE);
      return ok(res, {
        role: 'owner', forms: formsOut, members,
        responses: page.map((r) => serializeResponse(r, { includeMember: true })),
        nextBefore: rows.length > PAGE ? page.at(-1).submitted_at : null, timezone: tz,
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (isOwner) {
        if (body.action === 'create-form') {
          const count = (await sql`SELECT COUNT(*)::int AS n FROM program_checkin_forms WHERE program_id = ${programId} AND archived_at IS NULL`).rows[0].n;
          if (count >= MAX_FORMS) return badRequest(res, `A program can have up to ${MAX_FORMS} check-ins.`);
          const v = cleanForm(body); if (v.error) return badRequest(res, v.error);
          const f = v.value;
          const row = (await sql`
            INSERT INTO program_checkin_forms (program_id, workspace_id, title, frequency, weekday, questions, remind)
            VALUES (${programId}, ${wid}, ${f.title}, ${f.frequency}, ${f.weekday}, ${JSON.stringify(f.questions)}::jsonb, ${f.remind})
            RETURNING *`).rows[0];
          return created(res, { form: serializeForm(row) });
        }
        if (body.action === 'reply') {
          const rid = String(body.responseId || '');
          if (!isUuid(rid)) return notFound(res, 'Check-in not found');
          const text = String(body.body || '').trim().slice(0, 4000);
          if (!text) return badRequest(res, 'Write a reply first.');
          const r = (await sql`SELECT * FROM program_checkin_responses WHERE id = ${rid} AND program_id = ${programId} AND workspace_id = ${wid}`).rows[0];
          if (!r) return notFound(res, 'Check-in not found');
          const replies = Array.isArray(r.replies) ? r.replies : [];
          if (replies.length >= MAX_REPLIES) return badRequest(res, 'This check-in has the most replies it can hold.');
          const entry = { body: text, at: new Date().toISOString() };
          // Guarded on the length we read, so two racing replies never overwrite each other.
          const upd = (await sql`
            UPDATE program_checkin_responses SET replies = replies || ${JSON.stringify([entry])}::jsonb, updated_at = NOW()
             WHERE id = ${rid} AND workspace_id = ${wid} AND jsonb_array_length(replies) = ${replies.length}
             RETURNING *`).rows[0];
          if (!upd) return badRequest(res, 'Someone replied at the same moment. Please try again.');
          await notifyCheckinReply({ program, response: upd, replyIndex: replies.length });
          return ok(res, { response: serializeResponse(upd, { includeMember: true }) });
        }
        return badRequest(res, 'Members fill in check-ins. Use the builder to create one.');
      }
      // Member submits (or edits this period's answers).
      const formId = String(body.formId || '');
      if (!isUuid(formId)) return notFound(res, 'Check-in not found');
      const form = (await sql`SELECT * FROM program_checkin_forms WHERE id = ${formId} AND program_id = ${programId} AND workspace_id = ${wid} AND archived_at IS NULL`).rows[0];
      if (!form) return notFound(res, 'Check-in not found');
      const v = cleanAnswers(form.questions, body.answers, uploadWorkspacesFor(access));
      if (v.error) return badRequest(res, v.error);
      const period = currentPeriod(form, tz, now);
      // A client may name the period it is editing; anything but the
      // current one is closed.
      if (body.periodKey && String(body.periodKey) !== period.key) return forbidden(res, 'That check-in period has ended.');
      const row = (await sql`
        INSERT INTO program_checkin_responses (form_id, program_id, workspace_id, client_id, period_key, answers)
        VALUES (${formId}, ${programId}, ${wid}, ${access.clientId}, ${period.key}, ${JSON.stringify(v.value)}::jsonb)
        ON CONFLICT (form_id, client_id, period_key) DO UPDATE SET answers = EXCLUDED.answers, updated_at = NOW()
        RETURNING *, (xmax = 0) AS inserted`).rows[0];
      if (row.inserted) {
        const who = (await sql`SELECT COALESCE(mp.display_name, c.name) AS name FROM clients c
                                LEFT JOIN program_member_profiles mp ON mp.workspace_id = c.workspace_id AND mp.user_id = c.user_id
                                WHERE c.id = ${access.clientId}`).rows[0];
        notifyOwnerCheckin({ program, response: row, memberName: who?.name, formTitle: form.title });
      }
      return row.inserted ? created(res, { response: serializeResponse(row, { form }), edited: false }) : ok(res, { response: serializeResponse(row, { form }), edited: true });
    }

    if (req.method === 'PATCH') {
      if (!isOwner) return forbidden(res, 'Only the coach can change check-ins.');
      const body = await readBody(req);
      const formId = String(body.formId || '');
      if (!isUuid(formId)) return notFound(res, 'Check-in not found');
      const cur = (await sql`SELECT * FROM program_checkin_forms WHERE id = ${formId} AND program_id = ${programId} AND workspace_id = ${wid} AND archived_at IS NULL`).rows[0];
      if (!cur) return notFound(res, 'Check-in not found');
      const v = cleanForm(body, cur); if (v.error) return badRequest(res, v.error);
      const f = v.value;
      const row = (await sql`
        UPDATE program_checkin_forms SET title = ${f.title}, frequency = ${f.frequency}, weekday = ${f.weekday},
          questions = ${JSON.stringify(f.questions)}::jsonb, remind = ${f.remind}, updated_at = NOW()
         WHERE id = ${formId} AND workspace_id = ${wid} RETURNING *`).rows[0];
      return ok(res, { form: serializeForm(row) });
    }

    if (req.method === 'DELETE') {
      if (!isOwner) return forbidden(res, 'Only the coach can change check-ins.');
      const formId = String(req.query.formId || '');
      if (!isUuid(formId)) return notFound(res, 'Check-in not found');
      const r = await sql`UPDATE program_checkin_forms SET archived_at = NOW(), updated_at = NOW()
                          WHERE id = ${formId} AND program_id = ${programId} AND workspace_id = ${wid} AND archived_at IS NULL RETURNING id`;
      if (!r.rows.length) return notFound(res, 'Check-in not found');
      return ok(res, { archived: true });
    }
    return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  } catch (err) { return serverError(res, err); }
}
