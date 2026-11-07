// /api/calendar
//   GET    → full calendar state (settings + services + blocks + bookings)
//   PATCH  → update settings (biz_name, slug, slot_minutes, buffer_minutes, availability)

import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import {
  ensureCalendarSettings, serializeSettings, serializeService, serializeBlock,
  serializeBooking, VALID_HANDLE, DISCOVER_CATEGORY_SET,
  invalidateCalendarSettings,
} from '../_lib/calendar.js';
import { invalidateOwnerWorkspace } from '../_lib/clientPortal.js';
import { sessionsAsCalendarBlocks } from '../_lib/programEvents.js';
import { validateAvailability, validateTimezone } from '../_lib/settingsValidation.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { requireSameOrigin } from "../_lib/security.js";
import { clientRemindersFrom } from '../_lib/reminderSettings.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    // Helpers with the schedule permission read the calendar; settings
    // (PATCH) stay owner-only.
    const workspaceId = await ensureActiveWorkspace(user, req, res, {
      helper: req.method === 'GET' ? 'schedule' : undefined,
    });
    if (!workspaceId) return;
    if (req.method === 'GET') {
      // Per-query try/catch so a single missing table/column degrades to
      // an empty list instead of bricking the whole calendar tab. A
      // freshly-deployed install whose schema hasn't fully applied
      // would otherwise return 500 here.
      const safe = async (p, fallback) => { try { return await p; } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[calendar GET] sub-query failed:', e.message);
        return fallback;
      } };
      const settings = await safe(ensureCalendarSettings(workspaceId), {});
      const services = await safe(sql`
        SELECT * FROM services WHERE workspace_id = ${workspaceId}
        ORDER BY display_order, created_at
      `, { rows: [] });

      // Optional date-range filter. Without it (legacy callers) we
      // return the whole table; with from/to we narrow to the
      // requested window - backs the calendar view-mode loads so a
      // long-tenured owner with 10K+ past bookings doesn't download
      // their full history on every navigation. Validates ISO dates
      // (YYYY-MM-DD); anything malformed falls back to no-filter
      // rather than 400'ing (the page should still render).
      const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
      // Always bound the query window. Without an explicit range, default to a
      // generous window around today (90 days back, 540 forward) instead of
      // returning a tenant's ENTIRE history - an unbounded fetch melts the
      // calendar load for long-tenured / high-volume workspaces.
      const isoDay = (d) => d.toISOString().slice(0, 10);
      const dFrom = new Date(); dFrom.setUTCDate(dFrom.getUTCDate() - 90);
      const dTo = new Date(); dTo.setUTCDate(dTo.getUTCDate() + 540);
      const from = isIsoDate(req.query.from) ? req.query.from : isoDay(dFrom);
      const to   = isIsoDate(req.query.to)   ? req.query.to   : isoDay(dTo);

      // ?only=setup: the settings and services alone. Screens that only
      // need the service list (Services, Packages, Time, onboarding,
      // import) used to download months of bookings with every visit.
      const setupOnly = req.query.only === 'setup';

      const blocks = setupOnly ? { rows: [] } : await safe(sql`
        SELECT * FROM calendar_blocks
        WHERE workspace_id = ${workspaceId}
          AND date >= ${from}::date AND date <= ${to}::date
        ORDER BY date, start_min
      `, { rows: [] });

      // LEFT JOIN the booking's balance ("collect on the spot") invoice so
      // serializeBooking can show a unified deposit + balance payment status.
      const bookings = setupOnly ? { rows: [] } : await safe(sql`
        SELECT b.*, ci.status AS collect_invoice_status, ci.paid_amount AS collect_invoice_paid_amount
        FROM bookings b
        LEFT JOIN invoices ci ON ci.id = b.collect_invoice_id AND ci.workspace_id = b.workspace_id
        WHERE b.workspace_id = ${workspaceId}
          AND b.cancelled_at IS NULL
          AND b.date >= ${from}::date AND b.date <= ${to}::date
        ORDER BY b.date, b.start_min
      `, { rows: [] });
      // Program live sessions: read-only entries shaped like blocks so the
      // existing views show them (owner only; helpers see the plain schedule).
      const sessions = req.helper || setupOnly ? { rows: [] } : await safe(sql`
        SELECT e.id, e.program_id, e.title, e.starts_at, e.duration_min, p.title AS program_title
        FROM program_events e JOIN programs p ON p.id = e.program_id AND p.workspace_id = e.workspace_id
        WHERE e.workspace_id = ${workspaceId} AND e.cancelled_at IS NULL
          AND e.starts_at >= ${from}::date - INTERVAL '1 day' AND e.starts_at < ${to}::date + INTERVAL '2 days'
        ORDER BY e.starts_at
      `, { rows: [] });
      const sessionBlocks = sessionsAsCalendarBlocks(sessions.rows, settings?.timezone)
        .filter((b) => b.date >= from && b.date <= to);
      return ok(res, {
        calendar: {
          settings: serializeSettings(settings),
          services: services.rows.map((r) => serializeService(r, {
            reminderDefaultMinutes: clientRemindersFrom(settings?.client_reminders ?? null).minutes,
            owner: !req.helper,
          })),
          blocks:   [...blocks.rows.map(serializeBlock), ...sessionBlocks],
          // Helper mode (schedule permission): the calendar without revenue.
          bookings: bookings.rows.map((r) => serializeBooking(r, { redactMoney: !!req.helper })),
        },
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('bizName' in body) {
        const v = (body.bizName || '').toString().trim().slice(0, 120);
        if (!v) return badRequest(res, 'bizName cannot be empty');
        push('biz_name', v);
      }
      if ('slug' in body) {
        const slug = body.slug == null ? null : String(body.slug).toLowerCase().trim();
        if (slug !== null && !VALID_HANDLE.test(slug)) {
          return badRequest(res, 'Invalid handle (1–40 chars, lowercase letters/digits/hyphens)');
        }
        if (slug) {
          const clash = await sql`
            SELECT 1 FROM calendar_settings
            WHERE slug = ${slug} AND workspace_id <> ${workspaceId} LIMIT 1
          `;
          if (clash.rows.length > 0) return badRequest(res, 'That handle is taken');
        }
        push('slug', slug);
      }
      if ('slotMinutes' in body) {
        const n = Number(body.slotMinutes);
        if (![5, 10, 15, 20, 30, 45, 60].includes(n)) {
          return badRequest(res, 'slotMinutes must be one of 5, 10, 15, 20, 30, 45, 60');
        }
        push('slot_minutes', n);
      }
      if ('bufferMinutes' in body) {
        const n = Number(body.bufferMinutes);
        if (!Number.isInteger(n) || n < 0 || n > 240) return badRequest(res, 'bufferMinutes must be 0–240');
        push('buffer_minutes', n);
      }
      if ('packageUseOn' in body) {
        const v = String(body.packageUseOn || '');
        if (!['booking', 'completion'].includes(v)) return badRequest(res, 'packageUseOn must be booking or completion');
        push('package_use_on', v);
      }
      if ('minNoticeHours' in body) {
        // Minimum advance notice before a client can book (0 = allow
        // same-moment booking, still never the past). Cap at 30 days.
        const n = Number(body.minNoticeHours);
        if (!Number.isInteger(n) || n < 0 || n > 720) return badRequest(res, 'minNoticeHours must be 0–720');
        push('min_notice_hours', n);
      }
      if ('maxAdvanceDays' in body) {
        // How far ahead clients can book on the public page (0 = no limit).
        // Cap at 730 days (2 years).
        const n = Number(body.maxAdvanceDays);
        if (!Number.isInteger(n) || n < 0 || n > 730) return badRequest(res, 'maxAdvanceDays must be 0–730');
        push('max_advance_days', n);
      }
      if ('slotFitService' in body) {
        // TRUE → start times step by each service's own length (back-to-back);
        // FALSE → fixed slot_minutes grid.
        push('slot_fit_service', !!body.slotFitService);
      }
      if ('discoverable' in body) {
        push('discoverable', !!body.discoverable);
      }
      if ('tagline' in body) {
        const t = body.tagline == null ? null : String(body.tagline).trim().slice(0, 140);
        push('tagline', t || null);
      }
      if ('leadInstantReplyEnabled' in body) {
        push('lead_instant_reply_enabled', !!body.leadInstantReplyEnabled);
      }
      if ('leadInstantReplyMessage' in body) {
        const m = body.leadInstantReplyMessage == null ? null : String(body.leadInstantReplyMessage).trim().slice(0, 2000);
        push('lead_instant_reply_message', m || null);
      }
      if ('category' in body) {
        const c = body.category == null ? null : String(body.category).trim();
        if (c && !DISCOVER_CATEGORY_SET.has(c)) {
          return badRequest(res, 'Invalid category');
        }
        push('category', c || null);
      }
      if ('timezone' in body) {
        // IANA name (e.g. "America/New_York"). Drives every "today"/slot/.ics
        // computation; a bad value would silently mis-date bookings, so reject
        // it rather than store garbage. null clears it (callers fall back to UTC).
        // validateTimezone checks Intl AND pg_timezone_names - crons inline
        // this value into AT TIME ZONE, where a PG-unknown name throws for
        // the whole batch query.
        const tz = body.timezone == null || body.timezone === '' ? null : String(body.timezone).trim();
        if (tz) {
          const v = await validateTimezone(tz);
          if (v.error) return badRequest(res, 'Invalid timezone');
        }
        push('timezone', tz);
      }
      if ('addressLabel' in body) {
        const a = body.addressLabel == null ? null : String(body.addressLabel).trim().slice(0, 140);
        push('address_label', a || null);
      }
      if ('lat' in body) {
        const v = body.lat;
        if (v == null || v === '') push('lat', null);
        else {
          const n = Number(v);
          if (!Number.isFinite(n) || n < -90 || n > 90) return badRequest(res, 'lat must be between -90 and 90');
          push('lat', n);
        }
      }
      if ('lng' in body) {
        const v = body.lng;
        if (v == null || v === '') push('lng', null);
        else {
          const n = Number(v);
          if (!Number.isFinite(n) || n < -180 || n > 180) return badRequest(res, 'lng must be between -180 and 180');
          push('lng', n);
        }
      }
      if ('availability' in body) {
        // Shared validator (api/_lib/settingsValidation.js) — same source of
        // truth Ivy's set_availability tool uses, so they can never drift.
        const r = validateAvailability(body.availability);
        if (r.error) return badRequest(res, r.error);
        push('availability', JSON.stringify(r.value));
      }

      // Make sure a row exists, then patch.
      await ensureCalendarSettings(workspaceId);
      if (sets.length === 0) {
        const r = await ensureCalendarSettings(workspaceId);
        return ok(res, { settings: serializeSettings(r) });
      }
      sets.push('updated_at = NOW()');
      values.push(workspaceId);
      const queryText = `
        UPDATE calendar_settings SET ${sets.join(', ')}
        WHERE workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      // For availability we casted via JSON.stringify; ensure jsonb column accepts it.
      // (Postgres parses string into jsonb implicitly via parameter type.)
      // Bust the hot-caches so the next read (public booking page,
      // /api/me, an outgoing email) picks up the change immediately.
      // biz_name + slug live in calendar_settings but appear in
      // ownsWorkspace's SELECT, so both keys need eviction.
      invalidateCalendarSettings(workspaceId);
      invalidateOwnerWorkspace(user.id);
      // Hours saved: if the owner skipped the Hours step in onboarding, that
      // skip is now done with, so the dashboard checklist ticks it off.
      if ('availability' in body) {
        try {
          await sql`
            UPDATE users u
               SET onboarding_state = jsonb_set(
                     u.onboarding_state, '{skippedSteps}',
                     COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(u.onboarding_state->'skippedSteps') x
                                WHERE x <> '"availability"'::jsonb), '[]'::jsonb))
              FROM workspaces w
             WHERE w.id = ${workspaceId} AND u.id = w.owner_id
               AND jsonb_typeof(u.onboarding_state->'skippedSteps') = 'array'
               AND u.onboarding_state->'skippedSteps' @> '["availability"]'::jsonb
          `;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[calendar PATCH] clearing skipped availability failed (non-blocking):', e.message);
        }
      }
      return ok(res, { settings: serializeSettings(rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
