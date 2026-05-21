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
import { requireActiveSubscription } from '../_lib/subscriptionGate.js';
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
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(await requireActiveSubscription(workspaceId, req, res))) return;

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

      const depositType = s?.depositType || 'none';
      if (!['none', 'percent', 'fixed', 'full'].includes(depositType)) {
        return badRequest(res, `services[${idx}].depositType must be none / percent / fixed / full`);
      }
      const depositAmount = Number(s?.depositAmount ?? 0);
      if (!Number.isFinite(depositAmount) || depositAmount < 0) {
        return badRequest(res, `services[${idx}].depositAmount must be non-negative`);
      }
      if (depositType === 'percent' && depositAmount > 100) {
        return badRequest(res, `services[${idx}].depositAmount must be 0–100 when type is percent`);
      }

      // Mobile / on-location service config.
      const locationType = s?.locationType || 'in_person';
      if (!['in_person', 'mobile', 'virtual'].includes(locationType)) {
        return badRequest(res, `services[${idx}].locationType must be in_person / mobile / virtual`);
      }
      const travelBufferMinutes = Number.isInteger(s?.travelBufferMinutes)
        ? s.travelBufferMinutes : Number(s?.travelBufferMinutes ?? 0);
      if (!Number.isInteger(travelBufferMinutes)
          || travelBufferMinutes < 0 || travelBufferMinutes > 240) {
        return badRequest(res, `services[${idx}].travelBufferMinutes must be 0–240`);
      }
      // Free-form venue/address text. 500-char cap matches the
      // location_address column on bookings.
      const locationLabel = s?.locationLabel == null
        ? null
        : String(s.locationLabel).trim().slice(0, 500) || null;

      // Visibility — three-state. Default 'public' so existing services
      // that don't send the field stay listed.
      const visibility = s?.visibility || 'public';
      if (!['public', 'private', 'only_me'].includes(visibility)) {
        return badRequest(res, `services[${idx}].visibility must be public / private / only_me`);
      }

      // Cancellation / no-show policy. Both fees are optional; a 0
      // fee means "no auto-charge — owner can still cancel manually."
      const cancellationFeeAmount = Number(s?.cancellationFeeAmount ?? 0);
      if (!Number.isFinite(cancellationFeeAmount) || cancellationFeeAmount < 0) {
        return badRequest(res, `services[${idx}].cancellationFeeAmount must be non-negative`);
      }
      const cancellationWindowHours = Number.isInteger(s?.cancellationWindowHours)
        ? s.cancellationWindowHours : Number(s?.cancellationWindowHours ?? 24);
      if (!Number.isInteger(cancellationWindowHours)
          || cancellationWindowHours < 0 || cancellationWindowHours > 720) {
        return badRequest(res, `services[${idx}].cancellationWindowHours must be 0–720`);
      }
      const noShowFeeAmount = Number(s?.noShowFeeAmount ?? 0);
      if (!Number.isFinite(noShowFeeAmount) || noShowFeeAmount < 0) {
        return badRequest(res, `services[${idx}].noShowFeeAmount must be non-negative`);
      }

      // Per-service add-ons. Each: { id, name, price, durationMinutes }.
      // We mint an id for new entries so the public booker can refer
      // to them stably even if the owner reorders.
      const rawAddOns = Array.isArray(s?.addOns) ? s.addOns : [];
      if (rawAddOns.length > 30) return badRequest(res, `services[${idx}].addOns capped at 30`);
      const addOns = [];
      for (const a of rawAddOns) {
        const aname = (a?.name || '').toString().trim();
        if (!aname) continue;
        if (aname.length > 200) return badRequest(res, `services[${idx}].addOns: name too long`);
        const aPrice = Number(a?.price ?? 0);
        if (!Number.isFinite(aPrice) || aPrice < 0) {
          return badRequest(res, `services[${idx}].addOns: price must be non-negative`);
        }
        const aDur = Number.isInteger(a?.durationMinutes) ? a.durationMinutes : Number(a?.durationMinutes || 0);
        if (!Number.isInteger(aDur) || aDur < 0 || aDur > 480) {
          return badRequest(res, `services[${idx}].addOns: durationMinutes must be 0–480`);
        }
        addOns.push({
          id: a?.id || `ao_${Math.random().toString(36).slice(2, 10)}`,
          name: aname,
          price: Math.round(aPrice * 100) / 100,
          durationMinutes: aDur,
        });
      }

      // Per-service custom intake fields. Each:
      //   { id, label, type, required, options[] }
      const rawFields = Array.isArray(s?.customFields) ? s.customFields : [];
      if (rawFields.length > 20) return badRequest(res, `services[${idx}].customFields capped at 20`);
      const customFields = [];
      const VALID_FIELD_TYPE = new Set(['text', 'textarea', 'number', 'select', 'checkbox']);
      for (const f of rawFields) {
        const flabel = (f?.label || '').toString().trim();
        if (!flabel) continue;
        if (flabel.length > 200) return badRequest(res, `services[${idx}].customFields: label too long`);
        const ftype = (f?.type || 'text').toString();
        if (!VALID_FIELD_TYPE.has(ftype)) {
          return badRequest(res, `services[${idx}].customFields: invalid type ${ftype}`);
        }
        const options = Array.isArray(f?.options)
          ? f.options.map((o) => String(o).slice(0, 200)).filter(Boolean).slice(0, 30)
          : [];
        if (ftype === 'select' && options.length === 0) {
          return badRequest(res, `services[${idx}].customFields: select fields need options`);
        }
        customFields.push({
          id: f?.id || `cf_${Math.random().toString(36).slice(2, 10)}`,
          label: flabel,
          type: ftype,
          required: !!f?.required,
          options,
        });
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
        depositType,
        depositAmount,
        locationType,
        locationLabel,
        visibility,
        travelBufferMinutes,
        cancellationFeeAmount,
        cancellationWindowHours,
        noShowFeeAmount,
        addOns,
        customFields,
        // Per-service color for the calendar grid. Validate as
        // #RGB / #RRGGBB; anything else gets nulled so we don't
        // stuff junk into an inline style attribute.
        color: (typeof s?.color === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.color))
          ? s.color : null,
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
            intake_form_template_ids = ${s.intakeFormTemplateIds},
            deposit_type = ${s.depositType},
            deposit_amount = ${s.depositAmount},
            location_type = ${s.locationType},
            location_label = ${s.locationLabel},
            visibility = ${s.visibility},
            travel_buffer_minutes = ${s.travelBufferMinutes},
            cancellation_fee_amount = ${s.cancellationFeeAmount},
            cancellation_window_hours = ${s.cancellationWindowHours},
            no_show_fee_amount = ${s.noShowFeeAmount},
            add_ons = ${JSON.stringify(s.addOns)}::jsonb,
            custom_fields = ${JSON.stringify(s.customFields)}::jsonb,
            color = ${s.color || null}
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
            intake_form_template_ids, deposit_type, deposit_amount,
            location_type, location_label, visibility, travel_buffer_minutes,
            cancellation_fee_amount, cancellation_window_hours, no_show_fee_amount,
            add_ons, custom_fields, color
          )
          VALUES (
            ${workspaceId}, ${s.name}, ${s.durationMinutes}, ${s.price}, ${s.displayOrder},
            ${s.description}, ${s.photoUrl}, ${s.prepInstructions}, ${s.reminderMinutes}, ${s.capacity},
            ${s.intakeFormTemplateIds}, ${s.depositType}, ${s.depositAmount},
            ${s.locationType}, ${s.locationLabel}, ${s.visibility}, ${s.travelBufferMinutes},
            ${s.cancellationFeeAmount}, ${s.cancellationWindowHours}, ${s.noShowFeeAmount},
            ${JSON.stringify(s.addOns)}::jsonb, ${JSON.stringify(s.customFields)}::jsonb, ${s.color || null}
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
