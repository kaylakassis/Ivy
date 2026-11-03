// Shared pieces for turning appointments from somewhere else into Ivy
// bookings: Ivy's add_bookings_from_list (a photo or screenshot), the
// calendar-file import (api/import/calendar-file.js) and the Google Calendar
// import (api/import/google-events.js).
//
// Every import here is QUIET: it writes bookings and, when needed, client
// records, and nothing else. No confirmation email or text goes to a client,
// no automation fires and nothing is pushed to Google Calendar. Every query
// is scoped to the workspace passed in.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { isValidTimeZone } from './tz.js';

// Client match used by every booking import: email first, then exact name
// (case-insensitive), oldest record wins.
export async function findClientForBulk(workspaceId, r) {
  if (r.email) {
    const byEmail = await sql`SELECT id, name, email FROM clients WHERE workspace_id = ${workspaceId} AND LOWER(email) = ${String(r.email).toLowerCase()} LIMIT 1`;
    if (byEmail.rows[0]) return byEmail.rows[0];
  }
  if (!r.name) return null;
  const byName = await sql`SELECT id, name, email FROM clients WHERE workspace_id = ${workspaceId} AND LOWER(name) = LOWER(${r.name}) ORDER BY created_at ASC LIMIT 1`;
  return byName.rows[0] || null;
}

export async function findServiceForBulk(workspaceId, serviceName) {
  if (!serviceName) return null;
  const r = await sql`SELECT id, name, duration_minutes FROM services WHERE workspace_id = ${workspaceId} AND LOWER(name) = LOWER(${serviceName}) LIMIT 1`;
  return r.rows[0] || null;
}

// Matches the client, or adds them (stage active, source 'import'). Nothing
// is sent and no client_created automation fires: they are an existing
// client of the business, not a new lead. Returns { client, created }.
export async function findOrCreateBulkClient(workspaceId, r) {
  const found = await findClientForBulk(workspaceId, r);
  if (found) return { client: found, created: false };
  const ins = await sql`
    INSERT INTO clients (workspace_id, name, email, phone, stage, source)
    VALUES (${workspaceId}, ${r.name}, ${r.email || null}, ${r.phone || null}, 'active', 'import')
    RETURNING id, name, email`;
  return { client: ins.rows[0], created: true };
}

// Stable, fixed-length key for bookings.import_uid.
export function icsImportUid(uidKey) {
  return `ics:${crypto.createHash('sha256').update(String(uidKey)).digest('hex')}`;
}
export function googleImportUid(eventId) {
  return `google:${String(eventId).slice(0, 1024)}`;
}

// One read for a whole import: the workspace's live bookings between two
// dates plus which import uids already exist. Returns a checker:
//   isDuplicate({ importUid, date, startMin, clientEmail, clientName })
// A booking is a duplicate when it was already imported from the same uid,
// or a live booking starts at the same date + minute (for the same client,
// when the client is known). remember() records a booking just created so
// later rows in the same import see it.
export async function loadDuplicateIndex(workspaceId, { fromDate, toDate, importUids = [] }) {
  const atTime = new Map(); // `${date}|${startMin}` → [{ email, name }]
  if (fromDate && toDate) {
    const r = await sql`
      SELECT to_char(date, 'YYYY-MM-DD') AS date, start_min, client_email, client_name
        FROM bookings
       WHERE workspace_id = ${workspaceId} AND cancelled_at IS NULL
         AND date BETWEEN ${fromDate}::date AND ${toDate}::date`;
    for (const b of r.rows) add(b.date, b.start_min, b.client_email, b.client_name);
  }
  const uids = new Set();
  const want = [...new Set(importUids.filter(Boolean))];
  for (let i = 0; i < want.length; i += 1000) {
    const r = await sql`
      SELECT import_uid FROM bookings
       WHERE workspace_id = ${workspaceId} AND import_uid = ANY(${want.slice(i, i + 1000)}::text[])`;
    for (const row of r.rows) uids.add(row.import_uid);
  }
  function add(date, startMin, email, name) {
    const k = `${date}|${Number(startMin)}`;
    if (!atTime.has(k)) atTime.set(k, []);
    atTime.get(k).push({ email: (email || '').toLowerCase(), name: (name || '').toLowerCase().trim() });
  }
  return {
    isDuplicate({ importUid, date, startMin, clientEmail, clientName }) {
      if (importUid && uids.has(importUid)) return true;
      const list = atTime.get(`${date}|${Number(startMin)}`);
      if (!list || !list.length) return false;
      const email = (clientEmail || '').toLowerCase();
      const name = (clientName || '').toLowerCase().trim();
      if (!email && !name) return true;
      return list.some((b) => (email && b.email === email) || (name && b.name === name));
    },
    remember({ importUid, date, startMin, clientEmail, clientName }) {
      if (importUid) uids.add(importUid);
      add(date, startMin, clientEmail, clientName);
    },
  };
}

// Inserts one imported booking. ON CONFLICT on the per-workspace import_uid
// index makes a double submit (two tabs, a retry) a no-op instead of a second
// booking. Returns the row, or null when that uid was already imported.
// googleEventId links the booking to the owner's own Google event, which
// tells the Google sync to leave it alone (api/_lib/googleSync.js).
export async function insertImportedBooking({
  workspaceId, clientId, clientName, clientEmail, clientPhone,
  serviceId, date, startMin, endMin, notes, importUid, googleEventId, source = 'import',
}) {
  const r = await sql`
    INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, client_phone,
                          date, start_min, end_min, notes, source, import_uid, google_event_id)
    VALUES (${workspaceId}, ${serviceId || null}, ${clientId || null}, ${clientName}, ${clientEmail || ''}, ${clientPhone || null},
            ${date}, ${startMin}, ${endMin}, ${notes || null}, ${source}, ${importUid || null}, ${googleEventId || null})
    ON CONFLICT (workspace_id, import_uid) WHERE import_uid IS NOT NULL DO NOTHING
    RETURNING id, client_id, date, start_min, end_min, client_name`;
  return r.rows[0] || null;
}

// What the calendar imports need to read events: the workspace's zone, its
// services (to guess the service from an event title) and the owner's own
// addresses (so the owner is never mistaken for the client).
export async function loadImportContext(workspaceId) {
  const r = await sql`
    SELECT cs.timezone, cs.google_email, u.email AS owner_email
      FROM workspaces w
      LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id
      LEFT JOIN users u ON u.id = w.owner_id
     WHERE w.id = ${workspaceId}`;
  const row = r.rows[0] || {};
  const svc = await sql`SELECT id, name FROM services WHERE workspace_id = ${workspaceId} ORDER BY name LIMIT 500`;
  return {
    timeZone: isValidTimeZone(row.timezone) ? row.timezone : 'UTC',
    services: svc.rows.map((s) => ({ id: s.id, name: s.name })),
    ownerEmails: [row.owner_email, row.google_email].filter(Boolean).map((e) => String(e).toLowerCase()),
  };
}

// Notes for an imported booking: where it came from plus the original
// title / details, so nothing the owner wrote is lost. Plain text.
export function importNotes({ from, title, clientName, serviceName, description, location }) {
  const lines = [`Imported from ${from}.`];
  if (title && title !== clientName && title !== serviceName) lines.push(`Original title: ${title}`);
  if (location) lines.push(`Location: ${location}`);
  if (description) lines.push(String(description).slice(0, 1000));
  return lines.join('\n').slice(0, 4000);
}

// Creates one imported booking from an appointment read elsewhere (a
// calendar file event or a Google event). The client is matched (email, then
// name) or added like add_bookings_from_list does; with no client name the
// booking keeps the event title and no client record is made up.
// serviceId must already be checked against the workspace by the caller.
// Returns { status: 'created', booking } or { status: 'duplicate' }.
export async function importOneBooking(workspaceId, appt, dupIndex) {
  const { clientName, clientEmail, serviceId, date, startMin, endMin, notes, importUid, googleEventId, title } = appt;
  const probe = { importUid, date, startMin, clientEmail, clientName };
  if (dupIndex.isDuplicate(probe)) return { status: 'duplicate' };
  let client = null;
  if (clientName) {
    client = (await findOrCreateBulkClient(workspaceId, { name: clientName, email: clientEmail || null })).client;
  } else if (clientEmail) {
    client = await findClientForBulk(workspaceId, { email: clientEmail });
  }
  const booking = await insertImportedBooking({
    workspaceId,
    clientId: client?.id || null,
    clientName: String(client?.name || clientName || title || 'Appointment').slice(0, 200),
    clientEmail: client?.email || clientEmail || '',
    serviceId, date, startMin, endMin, notes, importUid, googleEventId,
  });
  if (!booking) return { status: 'duplicate' };
  dupIndex.remember(probe);
  return { status: 'created', booking };
}

// Clients on the new bookings who have no email: they get no reminders until
// the owner adds one. [{ clientId, name }], sorted by name.
export async function clientsMissingEmail(workspaceId, clientIds) {
  const ids = [...new Set((clientIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const r = await sql`
    SELECT id, name FROM clients
     WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::uuid[])
       AND (email IS NULL OR email = '')
     ORDER BY name`;
  return r.rows.map((c) => ({ clientId: c.id, name: c.name }));
}
