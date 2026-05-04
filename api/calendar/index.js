// /api/calendar
//   GET    → full calendar state (settings + services + blocks + bookings)
//   PATCH  → update settings (biz_name, slug, slot_minutes, buffer_minutes, availability)

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import {
  ensureCalendarSettings, serializeSettings, serializeService, serializeBlock,
  serializeBooking, VALID_HANDLE, DISCOVER_CATEGORY_SET,
} from '../_lib/calendar.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { requireSameOrigin } from "../_lib/security.js";

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    if (req.method === 'GET') {
      const settings = await ensureCalendarSettings(workspaceId);
      const services = await sql`
        SELECT * FROM services WHERE workspace_id = ${workspaceId}
        ORDER BY display_order, created_at
      `;
      const blocks = await sql`
        SELECT * FROM calendar_blocks WHERE workspace_id = ${workspaceId}
        ORDER BY date, start_min
      `;
      const bookings = await sql`
        SELECT * FROM bookings WHERE workspace_id = ${workspaceId} AND cancelled_at IS NULL
        ORDER BY date, start_min
      `;
      return ok(res, {
        calendar: {
          settings: serializeSettings(settings),
          services: services.rows.map(serializeService),
          blocks:   blocks.rows.map(serializeBlock),
          bookings: bookings.rows.map((r) => serializeBooking(r)),
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
      if ('discoverable' in body) {
        push('discoverable', !!body.discoverable);
      }
      if ('tagline' in body) {
        const t = body.tagline == null ? null : String(body.tagline).trim().slice(0, 140);
        push('tagline', t || null);
      }
      if ('category' in body) {
        const c = body.category == null ? null : String(body.category).trim();
        if (c && !DISCOVER_CATEGORY_SET.has(c)) {
          return badRequest(res, 'Invalid category');
        }
        push('category', c || null);
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
        const a = body.availability;
        if (!a || typeof a !== 'object') return badRequest(res, 'availability must be an object');
        for (const day of Object.keys(a)) {
          if (!/^[0-6]$/.test(day)) return badRequest(res, 'availability keys must be 0..6');
          if (!Array.isArray(a[day])) return badRequest(res, `availability[${day}] must be an array`);
          for (const w of a[day]) {
            if (!w || typeof w !== 'object') return badRequest(res, `availability window malformed`);
            if (!Number.isInteger(w.start) || !Number.isInteger(w.end)) return badRequest(res, 'window start/end must be ints');
            if (w.start < 0 || w.end > 24 * 60 || w.start >= w.end) return badRequest(res, 'window has invalid range');
          }
        }
        push('availability', JSON.stringify(a));
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
      return ok(res, { settings: serializeSettings(rows[0]) });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
