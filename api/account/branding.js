// /api/account/branding
//   GET   → current branding (logo URL, accent color, signature, biz name)
//   PATCH → update any subset; null clears.
//
// Branding lives on calendar_settings (which already keys per workspace
// and holds biz_name + slug). Centralizing it there means /me's
// public booking page and email branding stay in lockstep without a
// new join.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { isValidAccent, invalidateBranding } from '../_lib/branding.js';
import { invalidateOwnerWorkspace } from '../_lib/clientPortal.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    if (req.method === 'GET') {
      // Ensure a settings row exists so PATCH below has something to update.
      await sql`INSERT INTO calendar_settings (workspace_id) VALUES (${workspaceId}) ON CONFLICT DO NOTHING`;
      const r = await sql`
        SELECT biz_name, brand_logo_url, brand_logo_blob_pathname,
               brand_accent_color, brand_email_signature
          FROM calendar_settings WHERE workspace_id = ${workspaceId}
      `;
      const row = r.rows[0] || {};
      return ok(res, {
        branding: {
          businessName:    row.biz_name || '',
          logoUrl:         row.brand_logo_url || null,
          logoPathname:    row.brand_logo_blob_pathname || null,
          accentColor:     row.brand_accent_color || null,
          emailSignature:  row.brand_email_signature || '',
        },
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = [];
      const values = [];
      const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

      if ('businessName' in body) {
        const v = (body.businessName || '').toString().trim();
        if (v && v.length > 200) return badRequest(res, 'businessName too long');
        push('biz_name', v || null);
      }
      if ('logoUrl' in body) {
        const v = body.logoUrl ? String(body.logoUrl) : null;
        if (v && !/^https:\/\//.test(v)) return badRequest(res, 'logoUrl must be https');
        push('brand_logo_url', v);
      }
      if ('logoPathname' in body) {
        push('brand_logo_blob_pathname', body.logoPathname ? String(body.logoPathname) : null);
      }
      if ('accentColor' in body) {
        const v = body.accentColor ? String(body.accentColor).trim() : null;
        if (v && !isValidAccent(v)) return badRequest(res, 'accentColor must be a hex color (e.g., #2E3168)');
        push('brand_accent_color', v);
      }
      if ('emailSignature' in body) {
        const v = body.emailSignature ? String(body.emailSignature) : null;
        if (v && v.length > 2000) return badRequest(res, 'emailSignature too long (2000 char max)');
        push('brand_email_signature', v);
      }

      if (sets.length === 0) return ok(res, { ok: true });

      // Ensure settings row exists.
      await sql`INSERT INTO calendar_settings (workspace_id) VALUES (${workspaceId}) ON CONFLICT DO NOTHING`;

      sets.push('updated_at = NOW()');
      values.push(workspaceId);
      const queryText = `
        UPDATE calendar_settings SET ${sets.join(', ')}
         WHERE workspace_id = $${values.length}
         RETURNING biz_name, brand_logo_url, brand_logo_blob_pathname,
                   brand_accent_color, brand_email_signature
      `;
      const { rows } = await sql.query(queryText, values);
      const row = rows[0] || {};
      // Bust the hot-cache entries so the next email send + the next
      // /api/me read both pick up the change immediately instead of
      // waiting for the TTL. ownsWorkspace returns biz_name + slug from
      // calendar_settings, so a biz_name change here is observable on
      // the workspace cache too.
      invalidateBranding(workspaceId);
      invalidateOwnerWorkspace(user.id);
      return ok(res, {
        branding: {
          businessName:    row.biz_name || '',
          logoUrl:         row.brand_logo_url || null,
          logoPathname:    row.brand_logo_blob_pathname || null,
          accentColor:     row.brand_accent_color || null,
          emailSignature:  row.brand_email_signature || '',
        },
      });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
