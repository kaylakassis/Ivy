// Google OAuth + Calendar API client. Just the methods we need to
// connect a workspace (exchange code → refresh token), create a
// dedicated "Ivy OS Bookings" calendar, and push event CRUD on
// booking lifecycle. No SDK — direct fetch keeps the bundle slim.
//
// Required env vars:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//
// Owners click Connect in the Sync drawer → we redirect to Google's
// authorization page → Google redirects back to /api/calendar/google/callback
// with a code → we POST that code here for the refresh_token, encrypt it,
// store it on calendar_settings.

const AUTH_BASE  = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API_BASE   = 'https://www.googleapis.com/calendar/v3';

// Calendar API scope: full read/write on the user's calendar list +
// events. We need write to push bookings, read to support phase 3
// inbound busy-block sync without re-prompting.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'openid',
  'email',
];

export function isGoogleConfigured() {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function buildAuthUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // offline → issues a refresh_token; prompt=consent → refresh_token
    // is reliably re-issued even if the user already authorized us.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error_description || json.error || `Google ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Exchange the authorization code returned by Google for tokens. The
// refresh_token is what we keep; access_token is short-lived (1h) and
// we re-derive on demand.
export async function exchangeCode({ code, redirectUri }) {
  return postForm(TOKEN_URL, {
    code,
    client_id:     process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
  });
}

// Trade a long-lived refresh_token for a fresh access_token. Cached
// per request — if you need the same access_token across multiple API
// calls in one handler, refresh once and pass it around.
export async function refreshAccessToken(refreshToken) {
  if (!refreshToken) throw new Error('refresh token is required');
  const r = await postForm(TOKEN_URL, {
    refresh_token: refreshToken,
    client_id:     process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    grant_type:    'refresh_token',
  });
  return r.access_token;
}

// Best-effort revoke. Google succeeds even on already-revoked tokens.
export async function revokeToken(token) {
  if (!token) return;
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch { /* ignore — revoke is best-effort */ }
}

// /userinfo via the OIDC discovery endpoint — used after first connect
// so the UI can show "connected as kayla@gmail.com". Lightweight.
export async function fetchUserEmail(accessToken) {
  const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => ({}));
  return j.email || null;
}

// ─── Calendar API ───────────────────────────────────────────────────

async function calApi(path, { method = 'GET', accessToken, body }) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // 204 (e.g. on DELETE) returns no body.
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Google Calendar ${method} ${path} failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.googleCode = json?.error?.errors?.[0]?.reason;
    throw err;
  }
  return json;
}

// Creates a dedicated "Ivy OS Bookings" calendar in the user's account
// so our events live in their own colour-coded layer rather than mixing
// with personal events. Returns the calendar id.
export async function createIvyCalendar({ accessToken, summary = 'Ivy OS Bookings' }) {
  const cal = await calApi('/calendars', {
    method: 'POST', accessToken,
    body: {
      summary,
      description: 'Bookings from your Ivy OS workspace. Manage them in the Ivy OS app — edits made here will not sync back.',
      timeZone: 'UTC',
    },
  });
  return cal.id;
}

// Convert an Ivy OS booking into a Google Calendar event payload. Times
// are emitted as floating local-time (no Z) since we don't track the
// owner's timezone yet — Google interprets them in the calendar's tz.
function bookingToEvent({ booking, serviceName }) {
  const dtstart = `${booking.date}T${pad2(Math.floor(booking.start_min / 60))}:${pad2(booking.start_min % 60)}:00`;
  const dtend   = `${booking.date}T${pad2(Math.floor(booking.end_min   / 60))}:${pad2(booking.end_min   % 60)}:00`;
  const event = {
    summary: `${serviceName || 'Appointment'} — ${firstName(booking.client_name)}`,
    description: 'Manage in Ivy OS. Edits made in this calendar app will not sync back.',
    start: { dateTime: dtstart },
    end:   { dateTime: dtend },
    transparency: 'opaque',
    extendedProperties: {
      private: {
        ivy_booking_id: booking.id,
      },
    },
  };
  // Map our coarse recurrence onto RRULE the same way the iCal feed does.
  const rrule = mapRrule(booking.recurrence_rule, booking.recurrence_until);
  if (rrule) event.recurrence = [`RRULE:${rrule}`];
  return event;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function firstName(s) { return (s || 'client').trim().split(/\s+/)[0] || 'client'; }
function mapRrule(rule, until) {
  if (!rule) return null;
  let out = null;
  if (rule === 'weekly')   out = 'FREQ=WEEKLY';
  else if (rule === 'biweekly') out = 'FREQ=WEEKLY;INTERVAL=2';
  else if (rule === 'monthly')  out = 'FREQ=MONTHLY';
  else return null;
  if (until) {
    const d = String(until).slice(0, 10).replace(/-/g, '');
    out += `;UNTIL=${d}T235959Z`;
  }
  return out;
}

export async function insertEvent({ accessToken, calendarId, booking, serviceName }) {
  const ev = bookingToEvent({ booking, serviceName });
  const created = await calApi(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST', accessToken, body: ev,
  });
  return created.id;
}

export async function updateEvent({ accessToken, calendarId, eventId, booking, serviceName }) {
  const ev = bookingToEvent({ booking, serviceName });
  return calApi(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PUT', accessToken, body: ev,
  });
}

export async function deleteEvent({ accessToken, calendarId, eventId }) {
  return calApi(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE', accessToken,
  });
}

// FreeBusy query — fast endpoint that returns just `{ start, end }` busy
// windows without per-event detail. Used by the inbound sync to mirror
// the owner's personal calendar as opaque busy blocks, no titles or
// attendees fetched.
//
// timeMin / timeMax are RFC 3339 strings.
export async function fetchFreeBusy({ accessToken, calendarIds = ['primary'], timeMin, timeMax }) {
  const r = await calApi('/freeBusy', {
    method: 'POST', accessToken,
    body: {
      timeMin,
      timeMax,
      items: calendarIds.map((id) => ({ id })),
    },
  });
  // Flatten across all requested calendars; downstream collapses overlaps.
  const busy = [];
  for (const id of calendarIds) {
    const cal = r?.calendars?.[id];
    if (!cal) continue;
    for (const b of (cal.busy || [])) {
      if (b.start && b.end) busy.push({ start: b.start, end: b.end });
    }
  }
  return busy;
}

// Lists future events from a calendar so we can pull a stable per-event
// id (FreeBusy doesn't return ids — we'd lose track of which busy block
// to update vs delete on the next sync). Pulls only the fields needed:
// id, start, end, summary. Calendar API's /events endpoint with
// timeMin / singleEvents / maxResults.
export async function listEvents({ accessToken, calendarId = 'primary', timeMin, timeMax, maxResults = 250 }) {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',          // expand recurring instances
    orderBy: 'startTime',
    maxResults: String(maxResults),
    fields: 'items(id,summary,start,end,status,transparency)',
  });
  const r = await calApi(`/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`, {
    method: 'GET', accessToken,
  });
  return r?.items || [];
}
