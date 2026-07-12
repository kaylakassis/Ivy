// GET /api/calendar/google/callback?code=...&state=...
// OAuth redirect target. Verifies state against the cookie set by /connect,
// exchanges the code for tokens, encrypts the refresh_token, creates a
// dedicated "Ivy Bookings" calendar in the user's account, stores
// everything on calendar_settings, and redirects back to /calendar with
// a success/error flag.
import { sql } from '../../_lib/db.js';
import { requireUser } from '../../_lib/auth.js';
import { ensureActiveWorkspace } from '../../_lib/workspaceGate.js';
import { encrypt } from '../../_lib/secrets.js';
import { exchangeCode, fetchUserEmail, createIvyCalendar, isGoogleConfigured } from '../../_lib/google.js';
import { appUrl } from '../../_lib/tokens.js';
import { methodNotAllowed, serverError } from '../../_lib/json.js';

function parseCookies(req) {
  const raw = req.headers?.cookie || '';
  const out = {};
  raw.split(/;\s*/).forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1));
  });
  return out;
}

function bounce(res, query) {
  const params = new URLSearchParams(query);
  const url = `${appUrl()}/calendar?${params.toString()}`;
  res.statusCode = 302;
  res.setHeader('Location', url);
  // Always clear the state cookie on return.
  res.setHeader('Set-Cookie', 'gcal_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  res.end();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    if (!isGoogleConfigured()) return bounce(res, { google: 'unconfigured' });

    const { code, state, error } = req.query;
    if (error) return bounce(res, { google: 'denied' });
    if (!code || !state) return bounce(res, { google: 'invalid' });

    const cookies = parseCookies(req);
    if (!cookies.gcal_state || cookies.gcal_state !== state) {
      return bounce(res, { google: 'state-mismatch' });
    }

    const user = await requireUser(req, res);
    if (!user) return; // requireUser already wrote a 401
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const tokens = await exchangeCode({
      code,
      redirectUri: `${appUrl()}/api/calendar/google/callback`,
    });
    if (!tokens.refresh_token) {
      // Happens if the user previously connected and revoked our app
      // partway. prompt=consent in /connect should make this rare.
      return bounce(res, { google: 'no-refresh' });
    }

    const email = await fetchUserEmail(tokens.access_token);
    let calendarId;
    try {
      calendarId = await createIvyCalendar({ accessToken: tokens.access_token });
    } catch (err) {
      // If we can't create the dedicated calendar, fall back to the
      // user's primary so events still flow somewhere visible.
      // eslint-disable-next-line no-console
      console.warn('[google] could not create Ivy calendar:', err.message);
      calendarId = 'primary';
    }

    const enc = encrypt(tokens.refresh_token);

    await sql`
      INSERT INTO calendar_settings (
        workspace_id, google_refresh_token_encrypted,
        google_calendar_id, google_email, google_connected_at
      ) VALUES (
        ${workspaceId}, ${enc}, ${calendarId}, ${email}, NOW()
      )
      ON CONFLICT (workspace_id) DO UPDATE SET
        google_refresh_token_encrypted = EXCLUDED.google_refresh_token_encrypted,
        google_calendar_id             = EXCLUDED.google_calendar_id,
        google_email                   = EXCLUDED.google_email,
        google_connected_at            = EXCLUDED.google_connected_at
    `;

    return bounce(res, { google: 'connected' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[google] callback failed:', err);
    return bounce(res, { google: 'error' });
  }
}
