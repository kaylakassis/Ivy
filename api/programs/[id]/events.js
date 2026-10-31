// Live sessions of a program.
//   GET                               → { upcoming, past } for owner + members.
//                                       Members only receive the join link from
//                                       15 minutes before the start until the end.
//   GET  ?eventId=&format=ics         → { filename, ics, googleUrl } add-to-calendar
//   POST { title, startsAt, durationMin, locationType, ... }  → owner creates
//   POST { action: 'rsvp', eventId, status: 'going'|'not_going' } → member RSVP
//   PATCH { eventId, ...fields, recordingUrl?, cancel? }       → owner edits
//   DELETE ?eventId=                  → owner cancels (members who were going
//                                       are told once)
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { readBody } from '../../_lib/body.js';
import { requireSameOrigin } from '../../_lib/security.js';
import { isUuid } from '../../_lib/programs.js';
import { communityAccess, activeMembers } from '../../_lib/programCommunity.js';
import { serializeEvent, cleanEventInput, eventCalendarFile, eventEnd } from '../../_lib/programEvents.js';
import { notify } from '../../_lib/programCommunityNotify.js';
import { fetchBranding } from '../../_lib/branding.js';
import { badRequest, created, forbidden, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

async function findEvent(programId, eventId) {
  if (!isUuid(eventId)) return null;
  return (await sql`SELECT * FROM program_events WHERE id = ${eventId} AND program_id = ${programId}`).rows[0] || null;
}

async function shape(rows, access) {
  const ids = rows.map((r) => r.id);
  const counts = new Map(); const mine = new Map(); const attendees = new Map();
  if (ids.length) {
    const rs = (await sql.query(
      `SELECT r.event_id, r.client_id, r.status, COALESCE(mp.display_name, c.name) AS name
         FROM program_event_rsvps r JOIN clients c ON c.id = r.client_id AND c.workspace_id = r.workspace_id
         LEFT JOIN program_member_profiles mp ON mp.workspace_id = c.workspace_id AND mp.user_id = c.user_id
        WHERE r.event_id = ANY($1::uuid[]) ORDER BY r.created_at ASC`, [ids])).rows;
    for (const r of rs) {
      if (r.status === 'going') {
        counts.set(r.event_id, (counts.get(r.event_id) || 0) + 1);
        if (!attendees.has(r.event_id)) attendees.set(r.event_id, []);
        attendees.get(r.event_id).push({ name: r.name || 'Member' });
      }
      if (access.clientId && r.client_id === access.clientId) mine.set(r.event_id, r.status);
    }
  }
  const now = new Date();
  return rows.map((r) => serializeEvent(r, {
    role: access.role, rsvp: mine.get(r.id) || null, goingCount: counts.get(r.id) || 0,
    attendees: access.role === 'owner' ? (attendees.get(r.id) || []) : null, now,
  }));
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res); if (!user) return;
    const programId = String(req.query.id || '');
    const access = await communityAccess(user, programId);
    if (!access) return notFound(res, 'Program not found');
    const { program } = access;
    const isOwner = access.role === 'owner';

    if (req.method === 'GET') {
      if (req.query.eventId) {
        const ev = await findEvent(programId, String(req.query.eventId));
        if (!ev || (ev.cancelled_at && !isOwner)) return notFound(res, 'Session not found');
        const branding = await fetchBranding(program.workspace_id);
        return ok(res, eventCalendarFile(ev, { bizName: branding.businessName || '', programTitle: program.title, programId }));
      }
      // Members do not see sessions cancelled long ago; recent cancellations
      // stay so people who planned to come see what happened.
      const rows = (await sql`
        SELECT * FROM program_events WHERE program_id = ${programId}
          AND (${isOwner}::boolean OR cancelled_at IS NULL OR starts_at > NOW() - INTERVAL '1 day')
        ORDER BY starts_at ASC LIMIT 500`).rows;
      const all = await shape(rows, access);
      return ok(res, {
        role: access.role,
        upcoming: all.filter((e) => !e.past),
        past: all.filter((e) => e.past).reverse(),
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'rsvp') {
        if (isOwner) return forbidden(res, 'RSVPs are for members.');
        const ev = await findEvent(programId, String(body.eventId || ''));
        if (!ev) return notFound(res, 'Session not found');
        if (ev.cancelled_at) return badRequest(res, 'This session was cancelled.');
        if (eventEnd(ev).getTime() < Date.now()) return badRequest(res, 'This session has already happened.');
        const status = body.status === 'not_going' ? 'not_going' : body.status === 'going' ? 'going' : null;
        if (!status) return badRequest(res, 'Say whether you are going.');
        await sql`
          INSERT INTO program_event_rsvps (event_id, program_id, workspace_id, client_id, status)
          VALUES (${ev.id}, ${programId}, ${program.workspace_id}, ${access.clientId}, ${status})
          ON CONFLICT (event_id, client_id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`;
        const [out] = await shape([ev], access);
        return ok(res, { event: out });
      }
      if (!isOwner) return forbidden(res, 'Only the coach can schedule live sessions.');
      const v = cleanEventInput(body, null);
      if (!v.ok) return badRequest(res, v.errors[0]);
      const f = v.value;
      const { rows } = await sql`
        INSERT INTO program_events (program_id, workspace_id, title, description, starts_at, duration_min, location_type, video_url, location_text, external_url, recording_url, remind_everyone)
        VALUES (${programId}, ${program.workspace_id}, ${f.title}, ${f.description}, ${f.starts_at}, ${f.duration_min}, ${f.location_type},
                ${f.video_url || null}, ${f.location_text}, ${f.external_url}, ${f.recording_url || null}, ${f.remind_everyone})
        RETURNING *`;
      const [out] = await shape(rows, access);
      return created(res, { event: out });
    }

    if (req.method === 'PATCH' || req.method === 'DELETE') {
      if (!isOwner) return forbidden(res, 'Only the coach can change live sessions.');
      const body = req.method === 'PATCH' ? await readBody(req) : {};
      const ev = await findEvent(programId, String(req.method === 'DELETE' ? req.query.eventId : body.eventId || ''));
      if (!ev) return notFound(res, 'Session not found');
      if (req.method === 'DELETE' || body.cancel === true) {
        if (!ev.cancelled_at) {
          const upd = await sql`UPDATE program_events SET cancelled_at = NOW(), updated_at = NOW() WHERE id = ${ev.id} AND cancelled_at IS NULL RETURNING *`;
          if (upd.rows[0] && eventEnd(ev).getTime() > Date.now()) {
            const going = (await sql`SELECT client_id FROM program_event_rsvps WHERE event_id = ${ev.id} AND status = 'going'`).rows.map((r) => r.client_id);
            const live = new Set((await activeMembers(programId)).map((m) => m.client_id));
            await notify({ program, kind: 'event_cancelled', refId: ev.id, keys: going.filter((c) => live.has(c)) });
          }
        }
        const fresh = await findEvent(programId, ev.id);
        const [out] = await shape([fresh], access);
        return ok(res, { event: out, cancelled: true });
      }
      const v = cleanEventInput(body, ev);
      if (!v.ok) return badRequest(res, v.errors[0]);
      const f = { ...ev, ...v.value };
      const { rows } = await sql`
        UPDATE program_events SET title = ${f.title}, description = ${f.description}, starts_at = ${f.starts_at}, duration_min = ${f.duration_min},
          location_type = ${f.location_type}, video_url = ${f.video_url}, location_text = ${f.location_text}, external_url = ${f.external_url},
          recording_url = ${f.recording_url}, remind_everyone = ${f.remind_everyone}, updated_at = NOW()
         WHERE id = ${ev.id} AND program_id = ${programId} RETURNING *`;
      const row = rows[0];
      // Moved to a new time: the reminders may go out again for the new slot.
      if (new Date(row.starts_at).getTime() !== new Date(ev.starts_at).getTime()) {
        await sql`DELETE FROM program_community_notices WHERE ref_id = ${ev.id} AND kind IN ('event_24h', 'event_1h')`;
      }
      // First time a recording is added: every member hears about it once.
      if (row.recording_url && !ev.recording_url && !row.cancelled_at) {
        const keys = (await activeMembers(programId)).map((m) => m.client_id);
        await notify({ program, kind: 'recording', refId: ev.id, keys });
      }
      const [out] = await shape([row], access);
      return ok(res, { event: out });
    }
    return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'DELETE']);
  } catch (err) { return serverError(res, err); }
}
