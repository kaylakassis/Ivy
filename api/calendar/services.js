// PUT /api/calendar/services — replace the workspace's services list in one shot.
// Body: {
//   services: [{
//     id?, name, durationMinutes, price, displayOrder?,
//     description?, photoUrl?, prepInstructions?, reminderMinutes?
//   }]
// }
// Existing services keep their id (preserves booking links). New ones get a new id.
// Anything not in the new list is deleted.

import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { serializeService, DEFAULT_REMINDERS } from '../_lib/calendar.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const ALLOWED_REMINDER_MIN = 5;            // can't remind less than 5 min before
const ALLOWED_REMINDER_MAX = 60 * 24 * 60; // ...or more than 60 days before

export default async function handler(req, res) {
  if (req.method !== 'PUT') return methodNotAllowed(res, ['PUT']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const body = await readBody(req);
    if (!Array.isArray(body.services)) return badRequest(res, 'services must be an array');
    if (body.services.length > 50) return badRequest(res, 'Too many services (max 50)');

    const cleaned = [];
    for (const [idx, s] of body.services.entries()) {
      const name = (s?.name || '').toString().trim();
      const dur  = Number(s?.durationMinutes);
      const price = Number(s?.price ?? 0);
      if (!name) return badRequest(res, `services[${idx}].name is required`);
      if (name.length > 120) return badRequest(res, `services[${idx}].name too long`);
      if (!Number.isInteger(dur) || dur <= 0 || dur > 24 * 60) return badRequest(res, `services[${idx}].durationMinutes invalid`);
      if (!Number.isFinite(price) || price < 0) return badRequest(res, `services[${idx}].price invalid`);

      // New optional fields.
      const description      = s?.description      ? String(s.description).slice(0, 4000)      : null;
      const photoUrl         = s?.photoUrl         ? String(s.photoUrl).slice(0, 500)          : null;
      const prepInstructions = s?.prepInstructions ? String(s.prepInstructions).slice(0, 4000) : null;

      let reminderMinutes = Array.isArray(s?.reminderMinutes) ? s.reminderMinutes : null;
      if (reminderMinutes) {
        const cleanedReminders = [];
        for (const r of reminderMinutes) {
          const n = Number(r);
          if (!Number.isInteger(n) || n < ALLOWED_REMINDER_MIN || n > ALLOWED_REMINDER_MAX) {
            return badRequest(res, `services[${idx}].reminderMinutes contains an invalid value`);
          }
          cleanedReminders.push(n);
        }
        // De-dupe + sort largest-first (so 7d-out fires before 2h-out chronologically when scheduling).
        reminderMinutes = [...new Set(cleanedReminders)].sort((a, b) => b - a);
      } else {
        reminderMinutes = DEFAULT_REMINDERS.slice();
      }

      const capRaw = s?.capacity ?? 1;
      const capacity = Number.isInteger(capRaw) ? capRaw : Number(capRaw);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
        return badRequest(res, `services[${idx}].capacity must be 1–1000`);
      }

      const intakeFormTemplateIds = Array.isArray(s?.intakeFormTemplateIds)
        ? s.intakeFormTemplateIds.map((x) => String(x)).filter(Boolean).slice(0, 20)
        : [];
      if (intakeFormTemplateIds.some((id) => !/^[0-9a-fA-F-]{36}$/.test(id))) {
        return badRequest(res, `services[${idx}].intakeFormTemplateIds must be UUIDs`);
      }

      cleaned.push({
        id: s?.id || null,
        name,
        durationMinutes: dur,
        price,
        displayOrder: Number.isInteger(s?.displayOrder) ? s.displayOrder : idx,
        description,
        photoUrl,
        prepInstructions,
        reminderMinutes,
        capacity,
        intakeFormTemplateIds,
      });
    }

    // Validate every referenced template id belongs to this workspace
    // and is actually marked as a template. Single round-trip.
    const allTemplateRefs = Array.from(new Set(cleaned.flatMap((s) => s.intakeFormTemplateIds)));
    if (allTemplateRefs.length > 0) {
      const { rows: tplRows } = await sql.query(
        `SELECT id FROM documents
         WHERE workspace_id = $1 AND id = ANY($2) AND is_template = TRUE`,
        [workspaceId, allTemplateRefs],
      );
      const known = new Set(tplRows.map((r) => r.id));
      for (const s of cleaned) {
        for (const t of s.intakeFormTemplateIds) {
          if (!known.has(t)) return badRequest(res, `Unknown intake form template ${t}`);
        }
      }
    }

    // Read current services so we know which existing ids to keep.
    const existing = await sql`SELECT id FROM services WHERE workspace_id = ${workspaceId}`;
    const existingIds = new Set(existing.rows.map((r) => r.id));
    const incomingIds = new Set(cleaned.filter((s) => s.id).map((s) => s.id));

    // Delete services not in the incoming list.
    for (const id of existingIds) {
      if (!incomingIds.has(id)) {
        // eslint-disable-next-line no-await-in-loop
        await sql`DELETE FROM services WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      }
    }

    // Upsert each service.
    const out = [];
    for (const s of cleaned) {
      if (s.id && existingIds.has(s.id)) {
        // eslint-disable-next-line no-await-in-loop
        const u = await sql`
          UPDATE services SET
            name = ${s.name},
            duration_minutes = ${s.durationMinutes},
            price = ${s.price},
            display_order = ${s.displayOrder},
            description = ${s.description},
            photo_url = ${s.photoUrl},
            prep_instructions = ${s.prepInstructions},
            reminder_minutes = ${s.reminderMinutes},
            capacity = ${s.capacity},
            intake_form_template_ids = ${s.intakeFormTemplateIds}
          WHERE id = ${s.id} AND workspace_id = ${workspaceId}
          RETURNING *
        `;
        out.push(serializeService(u.rows[0]));
      } else {
        // eslint-disable-next-line no-await-in-loop
        const i = await sql`
          INSERT INTO services (
            workspace_id, name, duration_minutes, price, display_order,
            description, photo_url, prep_instructions, reminder_minutes, capacity,
            intake_form_template_ids
          )
          VALUES (
            ${workspaceId}, ${s.name}, ${s.durationMinutes}, ${s.price}, ${s.displayOrder},
            ${s.description}, ${s.photoUrl}, ${s.prepInstructions}, ${s.reminderMinutes}, ${s.capacity},
            ${s.intakeFormTemplateIds}
          )
          RETURNING *
        `;
        out.push(serializeService(i.rows[0]));
      }
    }

    return ok(res, { services: out });
  } catch (err) {
    return serverError(res, err);
  }
}
