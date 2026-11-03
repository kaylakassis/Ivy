// /api/import/google-events - turn events in the owner's connected Google
// Calendar into real Ivy bookings ("switching to Ivy").
//
//   GET  ?days=90 → { connected, events: [{ id, title, start, end, allDay,
//          attendees: [{ name, email }], clientName, clientEmail, serviceId,
//          serviceName, alreadyInIvy }] }
//        Upcoming events from the primary calendar (now → days ahead, 1-365).
//        Events Ivy itself put in Google are left out. All-day events are
//        listed with allDay=true (the app does not preselect them).
//   POST { events: [{ id, clientName, clientEmail?, serviceId? }] } (max 500)
//        → { created, skipped, missingEmail: [{ clientId, name }] }
//        Each event is read again from Google by id; times always come from
//        Google, never from the request. The booking keeps the event's id in
//        google_event_id (and import_uid 'google:<id>'), so the Google sync
//        never pushes a second copy and the busy-time sync does not block the
//        same slot twice (api/_lib/googleSync.js). Quiet: nothing is sent to
//        anyone. Importing the same event twice creates one booking.
import { requireUser, validEmail } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { listEventsForImport, getEventForImport } from '../_lib/google.js';
import { loadGoogleImportAccess } from '../_lib/googleSync.js';
import { guessClient, guessService } from '../_lib/icsParse.js';
import { zonedParts, zonedTimeToUtcMs } from '../_lib/tz.js';
import {
  loadImportContext, loadDuplicateIndex, googleImportUid, importOneBooking, importNotes, clientsMissingEmail,
} from '../_lib/bookingImport.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MAX_EVENTS = 500;
const DAY_MS = 86_400_000;
// Calendar entries that are not appointments.
const SKIP_TYPES = new Set(['outOfOffice', 'focusTime', 'workingLocation', 'birthday', 'fromGmail']);

function pad(n) { return String(n).padStart(2, '0'); }

// Wall-clock { date, startMin, endMin, allDay, startMs, endMs } of a Google
// event in the workspace zone, or null when its times are unusable.
function eventTimes(ev, tz) {
  if (ev?.start?.date) {
    const date = String(ev.start.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const startMs = zonedTimeToUtcMs(date, 0, tz);
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(ev.end?.date || '')) ? ev.end.date : null;
    const endMs = endDate ? zonedTimeToUtcMs(endDate, 0, tz) : startMs + DAY_MS;
    return { allDay: true, date, startMin: 0, endMin: 24 * 60, startMs, endMs: Math.max(endMs, startMs + DAY_MS) };
  }
  const startMs = Date.parse(ev?.start?.dateTime || '');
  let endMs = Date.parse(ev?.end?.dateTime || '');
  if (!Number.isFinite(startMs)) return null;
  if (!Number.isFinite(endMs) || endMs <= startMs) endMs = startMs + 60 * 60_000;
  const s = zonedParts(tz, new Date(startMs));
  const e = zonedParts(tz, new Date(endMs));
  const date = `${s.y}-${pad(s.m)}-${pad(s.d)}`;
  const endDate = `${e.y}-${pad(e.m)}-${pad(e.d)}`;
  let endMin = endDate === date ? e.minutes : 24 * 60;
  if (endMin <= s.minutes) endMin = Math.min(24 * 60, s.minutes + 60);
  return { allDay: false, date, startMin: s.minutes, endMin, startMs, endMs };
}

function attendeesOf(ev) {
  return (Array.isArray(ev?.attendees) ? ev.attendees : [])
    .filter((a) => !a.self && !a.resource && (a.email || a.displayName))
    .slice(0, 50)
    .map((a) => ({
      name: a.displayName ? String(a.displayName).slice(0, 120) : null,
      email: a.email && validEmail(String(a.email).toLowerCase()) ? String(a.email).toLowerCase().slice(0, 254) : null,
    }));
}

function ownEmailsFor(ev, ctx) {
  const own = [...ctx.ownerEmails];
  for (const a of (Array.isArray(ev?.attendees) ? ev.attendees : [])) if (a.self && a.email) own.push(String(a.email).toLowerCase());
  if (ev?.organizer?.self && ev.organizer.email) own.push(String(ev.organizer.email).toLowerCase());
  return own;
}

// Ids of Google events that Ivy itself pushed (booking sync), which must not
// come back in as imports.
async function ivyPushedIds(workspaceId, ids) {
  if (!ids.length) return new Set();
  const r = await sql`
    SELECT google_event_id FROM bookings
     WHERE workspace_id = ${workspaceId} AND google_event_id = ANY(${ids}::text[])
       AND (import_uid IS NULL OR import_uid NOT LIKE 'google:%')`;
  return new Set(r.rows.map((x) => x.google_event_id));
}

function isImportable(ev) {
  return ev && ev.id && ev.status !== 'cancelled'
    && !ev.extendedProperties?.private?.ivy_booking_id
    && !SKIP_TYPES.has(ev.eventType);
}

function googleUnavailable(res) {
  return res.status(502).json({ error: "We couldn't reach Google Calendar. Please try again in a minute." });
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, req.method === 'GET'
      ? [{ key: `import-google:list:ws:${workspaceId}`, max: 60, windowSeconds: 3600 }]
      : [{ key: `import-google:import:ws:${workspaceId}`, max: 20, windowSeconds: 3600 }])) return;

    const ctx = await loadImportContext(workspaceId);

    if (req.method === 'GET') {
      const daysRaw = Number.parseInt(req.query?.days, 10);
      const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, daysRaw)) : 90;
      const access = await loadGoogleImportAccess(workspaceId);
      if (!access.connected) return ok(res, { connected: false, events: [] });
      const now = Date.now();
      let listed;
      try {
        listed = await listEventsForImport({
          accessToken: access.accessToken,
          timeMin: new Date(now).toISOString(),
          timeMax: new Date(now + days * DAY_MS).toISOString(),
        });
      } catch (err) {
        console.warn('[import/google] list failed:', err.message);
        return googleUnavailable(res);
      }
      const pushed = await ivyPushedIds(workspaceId, listed.items.map((e) => String(e.id || '')).filter(Boolean));
      const rows = [];
      for (const ev of listed.items) {
        if (!isImportable(ev) || pushed.has(ev.id)) continue;
        const t = eventTimes(ev, ctx.timeZone);
        if (!t || (!t.allDay && t.startMs < now)) continue;
        const title = String(ev.summary || '').slice(0, 300);
        const attendees = attendeesOf(ev);
        const who = guessClient({ title, attendees, organizerEmail: null, ownerEmails: ownEmailsFor(ev, ctx), services: ctx.services });
        const svc = guessService(title, ctx.services);
        rows.push({ ev, t, title, attendees, who, svc, importUid: googleImportUid(ev.id) });
      }
      const dates = rows.map((r) => r.t.date).sort();
      const dup = await loadDuplicateIndex(workspaceId, {
        fromDate: dates[0], toDate: dates[dates.length - 1], importUids: rows.map((r) => r.importUid),
      });
      return ok(res, {
        connected: true,
        events: rows.map((r) => ({
          id: r.ev.id,
          title: r.title,
          start: new Date(r.t.startMs).toISOString(),
          end: new Date(r.t.endMs).toISOString(),
          allDay: r.t.allDay,
          attendees: r.attendees.map((a) => ({ name: a.name, email: a.email })),
          clientName: r.who.clientName,
          clientEmail: r.who.clientEmail,
          serviceId: r.svc?.serviceId || null,
          serviceName: r.svc?.serviceName || null,
          alreadyInIvy: dup.isDuplicate({
            importUid: r.importUid, date: r.t.date, startMin: r.t.startMin,
            clientEmail: r.who.clientEmail, clientName: r.who.clientName,
          }),
        })),
        ...(listed.more ? { more: true } : {}),
      });
    }

    // POST: import the chosen events.
    const body = await readBody(req);
    if (!Array.isArray(body?.events) || body.events.length === 0) return badRequest(res, 'Choose at least one event to import.');
    if (body.events.length > MAX_EVENTS) return badRequest(res, `Import at most ${MAX_EVENTS} events at a time.`);
    const serviceIds = new Set(ctx.services.map((s) => s.id));
    const wanted = [];
    const seen = new Set();
    let skipped = 0;
    for (const raw of body.events) {
      const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
      const clientName = typeof raw?.clientName === 'string' ? raw.clientName.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      if (!id || id.length > 1024 || seen.has(id)) { skipped++; continue; }
      seen.add(id);
      const em = typeof raw?.clientEmail === 'string' ? raw.clientEmail.trim().toLowerCase().slice(0, 254) : '';
      wanted.push({
        id,
        clientName: clientName || null,
        clientEmail: em && validEmail(em) ? em : null,
        serviceId: typeof raw?.serviceId === 'string' && serviceIds.has(raw.serviceId) ? raw.serviceId : null,
      });
    }

    const access = await loadGoogleImportAccess(workspaceId);
    if (!access.connected) return res.status(409).json({ error: 'Connect Google Calendar first, then try again.' });

    // Read the events again from Google: one listing over the import window,
    // then single lookups for anything it did not include.
    const now = Date.now();
    const byId = new Map();
    try {
      const listed = await listEventsForImport({
        accessToken: access.accessToken,
        timeMin: new Date(now - DAY_MS).toISOString(),
        timeMax: new Date(now + 366 * DAY_MS).toISOString(),
      });
      for (const ev of listed.items) if (ev?.id) byId.set(ev.id, ev);
      let lookups = 0;
      for (const w of wanted) {
        if (byId.has(w.id) || lookups >= 50) continue;
        lookups++;
        const ev = await getEventForImport({ accessToken: access.accessToken, eventId: w.id });
        if (ev?.id === w.id) byId.set(ev.id, ev);
      }
    } catch (err) {
      console.warn('[import/google] re-read failed:', err.message);
      return googleUnavailable(res);
    }
    const pushed = await ivyPushedIds(workspaceId, wanted.map((w) => w.id));

    const prepared = [];
    for (const w of wanted) {
      const ev = byId.get(w.id);
      if (!isImportable(ev) || pushed.has(w.id)) { skipped++; continue; }
      const t = eventTimes(ev, ctx.timeZone);
      if (!t || t.startMs < now - (t.allDay ? DAY_MS : 0)) { skipped++; continue; }
      const title = String(ev.summary || '').slice(0, 300);
      const svc = w.serviceId ? ctx.services.find((s) => s.id === w.serviceId) : null;
      prepared.push({ w, ev, t, title, svc });
    }
    const dates = prepared.map((p) => p.t.date).sort();
    const dup = await loadDuplicateIndex(workspaceId, {
      fromDate: dates[0], toDate: dates[dates.length - 1],
      importUids: prepared.map((p) => googleImportUid(p.w.id)),
    });

    let created = 0;
    const clientIds = [];
    for (const p of prepared) {
      const r = await importOneBooking(workspaceId, {
        clientName: p.w.clientName, clientEmail: p.w.clientEmail, serviceId: p.svc?.id || null,
        date: p.t.date, startMin: p.t.startMin, endMin: p.t.endMin, title: p.title,
        importUid: googleImportUid(p.w.id), googleEventId: p.w.id,
        notes: importNotes({
          from: 'Google Calendar', title: p.title, clientName: p.w.clientName, serviceName: p.svc?.name,
          description: p.ev.description ? String(p.ev.description).slice(0, 1000) : '',
          location: p.ev.location ? String(p.ev.location).slice(0, 300) : '',
        }),
      }, dup);
      if (r.status === 'created') { created++; if (r.booking.client_id) clientIds.push(r.booking.client_id); }
      else skipped++;
    }
    const missingEmail = await clientsMissingEmail(workspaceId, clientIds);
    return ok(res, { created, skipped, missingEmail });
  } catch (err) {
    return serverError(res, err);
  }
}
