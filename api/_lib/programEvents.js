// Program live sessions: validation, the member-safe shape (the join link
// only inside its window), calendar files and the reminder sweep.
import { sql } from './db.js';
import { makeDeadline, withTimeout } from './timeBudget.js';
import { mintVideoRoomUrl } from './calendar.js';
import { buildBookingInvite, buildGoogleCalendarUrl } from './ical.js';
import { appUrl } from './tokens.js';
import { cleanHttpsUrl, activeMembers } from './programCommunity.js';
import { notify } from './programCommunityNotify.js';

export const LOCATION_TYPES = new Set(['video', 'in_person', 'link']);
export const JOIN_OPENS_MIN = 15;

export const eventEnd = (r) => new Date(new Date(r.starts_at).getTime() + Number(r.duration_min || 60) * 60000);

// Members get the join link from 15 minutes before the start until the end.
export function joinWindowOpen(r, now = new Date()) {
  if (r.cancelled_at) return false;
  const start = new Date(r.starts_at).getTime();
  return now.getTime() >= start - JOIN_OPENS_MIN * 60000 && now.getTime() <= eventEnd(r).getTime();
}

export function serializeEvent(r, { role, rsvp = null, goingCount = 0, attendees = null, now = new Date() } = {}) {
  const isOwner = role === 'owner';
  const open = joinWindowOpen(r, now);
  const showLink = isOwner || open;
  const videoUrl = r.location_type === 'video' && showLink ? (r.video_url || null) : null;
  const externalUrl = r.location_type === 'link' && showLink ? (r.external_url || null) : null;
  const out = {
    id: r.id, programId: r.program_id, title: r.title, description: r.description || '',
    startsAt: r.starts_at, durationMin: Number(r.duration_min), endsAt: eventEnd(r).toISOString(),
    locationType: r.location_type, locationText: r.location_text || null,
    videoUrl, externalUrl, joinUrl: videoUrl || externalUrl || null,
    joinOpensAt: new Date(new Date(r.starts_at).getTime() - JOIN_OPENS_MIN * 60000).toISOString(),
    joinOpen: open,
    recordingUrl: r.recording_url || null,
    cancelledAt: r.cancelled_at || null,
    past: eventEnd(r).getTime() < now.getTime(),
    goingCount: Number(goingCount) || 0,
    rsvp: isOwner ? null : (rsvp || null),
    createdAt: r.created_at,
  };
  if (isOwner) { out.remindEveryone = !!r.remind_everyone; out.attendees = attendees || []; }
  return out;
}

// Body → column values. `existing` is the row being edited (PATCH).
export function cleanEventInput(body, existing = null) {
  const errors = [];
  const v = {};
  const has = (k) => body[k] !== undefined || !existing;
  if (has('title')) {
    v.title = String(body.title || '').trim().slice(0, 140);
    if (!v.title) errors.push('Give the session a title.');
  }
  if (has('description')) v.description = String(body.description || '').trim().slice(0, 5000) || null;
  if (has('startsAt')) {
    const d = new Date(body.startsAt);
    if (!body.startsAt || Number.isNaN(d.getTime())) errors.push('Pick a date and time.');
    else if (d.getTime() < Date.now() - 365 * 86400000 || d.getTime() > Date.now() + 3 * 365 * 86400000) errors.push('Pick a date within the next few years.');
    else v.starts_at = d.toISOString();
  }
  if (has('durationMin')) {
    const n = Math.round(Number(body.durationMin ?? 60));
    if (!Number.isFinite(n) || n < 5 || n > 720) errors.push('Length must be between 5 minutes and 12 hours.');
    else v.duration_min = n;
  }
  const type = body.locationType !== undefined ? String(body.locationType) : (existing?.location_type || 'video');
  if (!LOCATION_TYPES.has(type)) errors.push('Choose video call, in person or a link.');
  v.location_type = type;
  if (body.locationText !== undefined || !existing) v.location_text = String(body.locationText || '').trim().slice(0, 300) || null;
  const locText = v.location_text !== undefined ? v.location_text : existing?.location_text;
  if (type === 'in_person' && !locText) errors.push('Add where it happens.');
  if (body.externalUrl !== undefined || !existing) {
    const u = cleanHttpsUrl(body.externalUrl);
    if (u === undefined) errors.push('Links must start with https://');
    else v.external_url = u;
  }
  const ext = v.external_url !== undefined ? v.external_url : existing?.external_url;
  if (type === 'link' && !ext) errors.push('Add the link people use to join.');
  if (body.videoUrl !== undefined) {
    const u = cleanHttpsUrl(body.videoUrl);
    if (u === undefined) errors.push('Links must start with https://');
    else v.video_url = u;
  }
  // A video session always has a room: the owner's own link, or a fresh one.
  if (type === 'video' && !(v.video_url !== undefined ? v.video_url : existing?.video_url)) v.video_url = mintVideoRoomUrl();
  if (body.recordingUrl !== undefined) {
    const u = cleanHttpsUrl(body.recordingUrl);
    if (u === undefined) errors.push('Recording links must start with https://');
    else v.recording_url = u;
  }
  if (body.remindEveryone !== undefined || !existing) v.remind_everyone = !!body.remindEveryone;
  return { ok: errors.length === 0, errors, value: v };
}

export function eventCalendarFile(r, { bizName, programTitle, programId }) {
  const start = new Date(r.starts_at);
  const date = start.toISOString().slice(0, 10);
  const startMin = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMin = startMin + Number(r.duration_min || 60);
  const url = `${appUrl()}/me/programs/${programId}`;
  const locationAddress = r.location_type === 'in_person' ? (r.location_text || '') : 'Online. The join link shows on the program page.';
  const description = `${r.description ? `${r.description}\n\n` : ''}Part of ${programTitle}. Open the program: ${url}`;
  const ics = buildBookingInvite({
    bizName, serviceName: r.title, date, startMin, endMin, bookingId: `program-event-${r.id}`,
    locationAddress, description, url, timezone: 'UTC', method: 'PUBLISH',
    status: r.cancelled_at ? 'CANCELLED' : 'CONFIRMED',
  });
  const googleUrl = buildGoogleCalendarUrl({ bizName, serviceName: r.title, date, startMin, endMin, timezone: 'UTC', locationAddress, description });
  const filename = `${String(r.title).replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'live-session'}.ics`;
  return { ics, googleUrl, filename };
}

// Who a reminder goes to: members who said they are going, or every
// active member (minus those who said no) when the owner ticked
// "Remind everyone".
export async function reminderRecipients(ev) {
  const members = await activeMembers(ev.program_id);
  const live = new Set(members.map((m) => m.client_id));
  const rs = (await sql`SELECT client_id, status FROM program_event_rsvps WHERE event_id = ${ev.id}`).rows;
  const going = new Set(rs.filter((r) => r.status === 'going').map((r) => r.client_id));
  const notGoing = new Set(rs.filter((r) => r.status === 'not_going').map((r) => r.client_id));
  if (ev.remind_everyone) return [...live].filter((c) => !notGoing.has(c));
  return [...going].filter((c) => live.has(c));
}

// Cron: 24-hour and 1-hour reminders. A session inside the last hour only
// gets the 1-hour one. Dedupe is the notice key (kind, event, member).
export async function sendDueReminders() {
  const { rows } = await sql`
    SELECT e.*, p.title AS program_title FROM program_events e JOIN programs p ON p.id = e.program_id
     WHERE e.cancelled_at IS NULL AND p.status <> 'archived'
       AND e.starts_at > NOW() AND e.starts_at <= NOW() + INTERVAL '24 hours'
     ORDER BY e.starts_at ASC LIMIT 200`;
  let sent = 0;
  const deadline = makeDeadline();
  for (const ev of rows) {
    // Stay inside the platform's time limit; the next run continues.
    if (deadline.passed()) break;
    const program = (await sql`SELECT * FROM programs WHERE id = ${ev.program_id}`).rows[0];
    const kind = new Date(ev.starts_at).getTime() - Date.now() <= 3600000 ? 'event_1h' : 'event_24h';
    const keys = await reminderRecipients(ev);
    if (!keys.length) continue;
    const r = await withTimeout(notify({ program, kind, refId: ev.id, keys }), 60_000, { pushed: 0 });
    sent += r?.pushed || 0;
  }
  return sent;
}

// Owner calendar: live sessions as read-only entries shaped like calendar
// blocks (date + minutes in the workspace zone) so the existing views show
// them. They never change the public booking page's availability.
export function sessionsAsCalendarBlocks(rows, tz) {
  const out = [];
  for (const r of rows) {
    const start = new Date(r.starts_at);
    let parts;
    try {
      const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      parts = Object.fromEntries(dtf.formatToParts(start).map((p) => [p.type, p.value]));
    } catch { parts = null; }
    if (!parts) continue;
    const startMin = (parts.hour === '24' ? 0 : Number(parts.hour)) * 60 + Number(parts.minute);
    out.push({
      id: `program-event-${r.id}`,
      date: `${parts.year}-${parts.month}-${parts.day}`,
      startMin,
      endMin: Math.min(1440, startMin + Number(r.duration_min || 60)),
      label: `Live: ${r.title}`,
      blocksBookings: false,
      color: null,
      notes: r.program_title ? `Live session in ${r.program_title}` : null,
      allDay: false,
      readOnly: true,
      programId: r.program_id,
      programEventId: r.id,
    });
  }
  return out;
}
