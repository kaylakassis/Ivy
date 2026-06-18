// GET /api/calendar/feed/:token
// Public iCal subscription endpoint. The owner pastes the URL into Google
// Cal / Apple Cal / Outlook; that app polls every ~15 min – ~24h and
// renders the bookings as a read-only calendar layer alongside their
// personal events.
//
// Token authentication: we sha256 the token at write time (see
// /api/calendar/feed-token) and compare hashes here. Owner can regenerate
// to revoke a leaked URL.
//
// Output is the workspace's UPCOMING bookings (cancelled excluded). We
// don't include past data because subscription feeds are about "what's on
// my calendar" and historical clutter slows down some calendar apps.
import crypto from 'node:crypto';
import { sql } from '../../_lib/db.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { buildICalFeed } from '../../_lib/ical.js';
import { notFound, methodNotAllowed, serverError } from '../../_lib/json.js';

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      // Calendar apps poll legitimately - generous bucket per IP.
      { key: `ical:ip:${ip}`, max: 240, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const rawToken = (req.query.token || '').toString();
    if (typeof rawToken !== 'string' || rawToken.length < 16) {
      return notFound(res, 'Calendar feed not found.');
    }
    const tokenHash = hashToken(rawToken);

    const { rows: csRows } = await sql`
      SELECT workspace_id, biz_name FROM calendar_settings
      WHERE ical_feed_token_hash = ${tokenHash}
      LIMIT 1
    `;
    const cs = csRows[0];
    if (!cs) return notFound(res, 'Calendar feed not found.');

    const [bookingRes, serviceRes] = await Promise.all([
      // Pull a 30-day historical window for context + everything ahead.
      // Recurring bookings expand on the calendar app's side from RRULE.
      sql`
        SELECT id, service_id, client_name, date, start_min, end_min,
               cancelled_at, recurrence_rule, recurrence_until, cancelled_occurrences
        FROM bookings
        WHERE workspace_id = ${cs.workspace_id}
          AND cancelled_at IS NULL
          AND date >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY date, start_min
      `,
      sql`
        SELECT id, name FROM services WHERE workspace_id = ${cs.workspace_id}
      `,
    ]);

    const ics = buildICalFeed({
      bizName:  cs.biz_name,
      bookings: bookingRes.rows,
      services: serviceRes.rows,
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // Subscribed clients should re-fetch frequently. 15 minutes balances
    // freshness with load.
    res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=900');
    res.setHeader('Content-Disposition', 'inline; filename="ivy-bookings.ics"');
    return res.status(200).send(ics);
  } catch (err) {
    return serverError(res, err);
  }
}
