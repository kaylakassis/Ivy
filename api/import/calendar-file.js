// POST /api/import/calendar-file - bring appointments in from a calendar file
// (.ics) exported from another booking app or calendar.
//
// Body: { ics: string (<= 2 MB of text), mode: 'preview' | 'import', uids?: string[] }
//
//   preview → { events: [{ uid, title, start, end, allDay, clientName,
//               clientEmail, serviceId, serviceName, duplicate, past,
//               recurring }], totals: { found, upcoming, past, duplicates },
//               truncated }
//   import  → { created, skipped, missingEmail: [{ clientId, name }] }
//
// Only events from now until 12 months ahead can be imported; past ones are
// listed with past=true and never imported. Repeating events are expanded
// for that window, 500 occurrences at most. Import creates bookings for the
// selected uids (default: every upcoming, non-duplicate event that is not
// all-day), matching or adding clients like Ivy's add_bookings_from_list.
// It is quiet: no confirmation email or text to anyone, no automation and
// no push to Google Calendar. The file is parsed again on import (the server
// never trusts times sent back by the browser), and every write is scoped to
// the caller's workspace.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { parseIcs, guessClient, guessService, ICS_MAX_BYTES } from '../_lib/icsParse.js';
import {
  loadImportContext, loadDuplicateIndex, icsImportUid, importOneBooking, importNotes, clientsMissingEmail,
} from '../_lib/bookingImport.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MAX_UIDS = 2000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const body = await readBody(req);
    const mode = body?.mode === 'import' ? 'import' : body?.mode === 'preview' ? 'preview' : null;
    if (!mode) return badRequest(res, "mode must be 'preview' or 'import'");
    if (await enforce(req, res, mode === 'import'
      ? [{ key: `import-ics:import:ws:${workspaceId}`, max: 20, windowSeconds: 3600 }]
      : [{ key: `import-ics:preview:ws:${workspaceId}`, max: 60, windowSeconds: 3600 }])) return;
    if (typeof body.ics !== 'string' || !body.ics.trim()) return badRequest(res, 'Choose a calendar file (.ics) to import.');
    if (Buffer.byteLength(body.ics, 'utf8') > ICS_MAX_BYTES) {
      return res.status(413).json({ error: 'That calendar file is too large. Files up to 2 MB work.' });
    }
    let uids = null;
    if (body.uids != null) {
      if (!Array.isArray(body.uids) || body.uids.length > MAX_UIDS) return badRequest(res, `uids must be a list of at most ${MAX_UIDS}`);
      uids = new Set(body.uids.filter((u) => typeof u === 'string' && u.length <= 300));
    }

    const ctx = await loadImportContext(workspaceId);
    const parsed = parseIcs(body.ics, { timeZone: ctx.timeZone, now: new Date() });
    if (parsed.error) return badRequest(res, parsed.error);

    const events = parsed.events.map((ev) => {
      const who = guessClient({ title: ev.title, attendees: ev.attendees, organizerEmail: ev.organizerEmail, ownerEmails: ctx.ownerEmails, services: ctx.services });
      const svc = guessService(ev.title, ctx.services);
      return { ...ev, ...who, serviceId: svc?.serviceId || null, serviceName: svc?.serviceName || null, importUid: icsImportUid(ev.uid) };
    });
    const dates = events.map((e) => e.date).sort();
    const dup = await loadDuplicateIndex(workspaceId, {
      fromDate: dates[0], toDate: dates[dates.length - 1],
      importUids: events.map((e) => e.importUid),
    });

    if (mode === 'preview') {
      let duplicates = 0;
      const out = events.map((e) => {
        const duplicate = dup.isDuplicate(e);
        if (duplicate && !e.past) duplicates++;
        return {
          uid: e.uid, title: e.title, start: e.start, end: e.end, allDay: e.allDay,
          clientName: e.clientName, clientEmail: e.clientEmail,
          serviceId: e.serviceId, serviceName: e.serviceName,
          duplicate, past: e.past, recurring: e.recurring,
        };
      });
      return ok(res, { events: out, totals: { ...parsed.totals, duplicates }, truncated: !!parsed.truncated });
    }

    // Import.
    let created = 0;
    let skipped = 0;
    const clientIds = [];
    for (const e of events) {
      const chosen = uids ? uids.has(e.uid) : !e.allDay && !e.past;
      if (!chosen) continue;
      if (e.past) { skipped++; continue; }
      const r = await importOneBooking(workspaceId, {
        clientName: e.clientName, clientEmail: e.clientEmail, serviceId: e.serviceId,
        date: e.date, startMin: e.startMin, endMin: e.endMin, title: e.title,
        importUid: e.importUid,
        notes: importNotes({ from: 'a calendar file', title: e.title, clientName: e.clientName, serviceName: e.serviceName, description: e.description, location: e.location }),
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
