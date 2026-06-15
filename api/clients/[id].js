// /api/clients/:id
//   GET    → single client (workspace-scoped)
//   PATCH  → update name / email / stage / tags / notes / lifetime_value / last_seen_at
//   DELETE → remove

import crypto from 'node:crypto';
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { fetchOwnedClient, serializeClient, VALID_STAGES } from '../_lib/clients.js';
import { normalizePhone } from '../_lib/sms.js';
import { badRequest, methodNotAllowed, noContent, notFound, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const { id } = req.query;

    const existing = await fetchOwnedClient({ id, workspaceId });
    if (!existing) return notFound(res, 'Client not found');

    if (req.method === 'GET') {
      return ok(res, { client: serializeClient(existing) });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('name' in body) {
        const v = (body.name || '').toString().trim();
        if (!v) return badRequest(res, 'Name cannot be empty');
        if (v.length > 120) return badRequest(res, 'Name too long');
        push('name', v);
      }
      if ('email' in body) push('email', body.email ? body.email.toString().trim().toLowerCase() : null);
      if ('phone' in body) {
        const raw = body.phone ? String(body.phone).trim() : null;
        if (raw === null || raw === '') push('phone', null);
        else {
          const norm = normalizePhone(raw);
          if (!norm) return badRequest(res, 'Phone number is not a valid format');
          push('phone', norm);
        }
      }
      if ('smsConsent' in body) {
        // Owners can record consent on behalf of the client (e.g. paper
        // intake form). Setting to false also nulls the consent
        // timestamp; setting to true stamps NOW() if not already set.
        if (body.smsConsent) {
          // Use IS NULL guard via separate path — do it inline:
          const cur = existing.sms_consent_at;
          if (!cur) push('sms_consent_at', new Date().toISOString());
        } else {
          push('sms_consent_at', null);
        }
      }
      if ('stage' in body) {
        if (!VALID_STAGES.has(body.stage)) return badRequest(res, 'Invalid stage');
        push('stage', body.stage);
      }
      if ('tags' in body) {
        if (!Array.isArray(body.tags)) return badRequest(res, 'Tags must be an array of strings');
        push('tags', body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20));
      }
      if ('notes' in body) push('notes', body.notes == null ? null : String(body.notes).slice(0, 4000));
      if ('lifetimeValue' in body) {
        const n = Number(body.lifetimeValue);
        if (!Number.isFinite(n) || n < 0) return badRequest(res, 'lifetimeValue must be a non-negative number');
        push('lifetime_value', n);
      }
      if ('source' in body) push('source', body.source ? String(body.source).slice(0, 60) : null);
      if ('referredByClientId' in body) {
        const ref = body.referredByClientId ? String(body.referredByClientId) : null;
        if (ref) {
          if (ref === id) return badRequest(res, "A client can't refer themselves");
          const owns = await sql`SELECT id FROM clients WHERE id = ${ref} AND workspace_id = ${workspaceId}`;
          if (owns.rows.length === 0) return badRequest(res, 'Unknown referring client');
        }
        push('referred_by_client_id', ref);
      }
      if ('lastSeenAt' in body) push('last_seen_at', body.lastSeenAt ? new Date(body.lastSeenAt).toISOString() : null);
      if ('address' in body) {
        push('address', body.address ? String(body.address).trim().slice(0, 500) : null);
      }
      if ('photoUrl' in body) {
        push('photo_url', body.photoUrl ? String(body.photoUrl).slice(0, 1000) : null);
      }
      if ('attachments' in body) {
        if (!Array.isArray(body.attachments)) {
          return badRequest(res, 'attachments must be an array');
        }
        if (body.attachments.length > 100) {
          return badRequest(res, 'Up to 100 attachments per client');
        }
        // Sanitize each entry — only the URL/type/name/uploadedAt
        // shape we control. Strip anything else clients send so a
        // client-side bug can't poison the row with arbitrary JSON.
        const cleaned = body.attachments.map((a) => ({
          url:        String(a?.url || '').slice(0, 1000),
          type:       String(a?.type || '').slice(0, 80),
          name:       a?.name ? String(a.name).slice(0, 200) : null,
          uploadedAt: a?.uploadedAt ? String(a.uploadedAt).slice(0, 40) : new Date().toISOString(),
        })).filter((a) => a.url && a.type);
        // Cast inline because the dynamic query builder produces a
        // bare $N placeholder; without the cast PG won't assign TEXT
        // to a JSONB column.
        values.push(JSON.stringify(cleaned));
        sets.push(`attachments = $${values.length}::jsonb`);
      }
      if ('galleryPhotos' in body) {
        if (!Array.isArray(body.galleryPhotos)) {
          return badRequest(res, 'galleryPhotos must be an array');
        }
        if (body.galleryPhotos.length > 200) {
          return badRequest(res, 'Up to 200 gallery photos per client');
        }
        // Same defense-in-depth shape sanitization as attachments —
        // we only persist the keys we render. Caption is optional;
        // takenAt is when the photo was actually taken (per the
        // owner's annotation); uploadedAt is the upload time we set
        // server-side if missing.
        const cleanedGallery = body.galleryPhotos.map((p) => ({
          id:           p?.id ? String(p.id).slice(0, 64) : crypto.randomUUID(),
          url:          String(p?.url || '').slice(0, 1000),
          blobPathname: p?.blobPathname ? String(p.blobPathname).slice(0, 400) : null,
          caption:      p?.caption ? String(p.caption).slice(0, 280) : null,
          takenAt:      p?.takenAt ? String(p.takenAt).slice(0, 40) : null,
          uploadedAt:   p?.uploadedAt ? String(p.uploadedAt).slice(0, 40) : new Date().toISOString(),
        })).filter((p) => p.url);
        values.push(JSON.stringify(cleanedGallery));
        sets.push(`gallery_photos = $${values.length}::jsonb`);
      }

      if (sets.length === 0) return ok(res, { client: serializeClient(existing) });

      sets.push(`updated_at = NOW()`);
      values.push(id, workspaceId);
      const queryText = `
        UPDATE clients SET ${sets.join(', ')}
        WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
        RETURNING *
      `;
      const { rows } = await sql.query(queryText, values);
      return ok(res, { client: serializeClient(rows[0]) });
    }

    if (req.method === 'DELETE') {
      await sql`DELETE FROM clients WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      return noContent(res);
    }

    return methodNotAllowed(res, ['GET', 'PATCH', 'DELETE']);
  } catch (err) {
    return serverError(res, err);
  }
}
