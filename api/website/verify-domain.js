// POST /api/website/verify-domain
//
// Resolves the owner's custom_domain via DNS and checks whether it
// CNAMEs to our platform. On success the row's domain_status flips to
// 'verified' and Vercel routes traffic for the domain to the same
// SSR endpoints used for /site/:handle.
//
// Owners get the host/CNAME to set + a "Verify now" button in the
// Editor. They're free to call this as often as they want; we
// rate-limit to keep the lookups bounded.

import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import dns from 'node:dns/promises';

// The platform-level CNAME owners point their domain at. Owners type
// "rivers.com" → CNAME rivers.com → cname.getivyos.com. Set via env so
// staging + prod can differ.
const TARGET_CNAME = process.env.WEBSITE_CNAME_TARGET || 'cname.getivyos.com';

// Trim trailing dots and lowercase everything so the comparison is
// deterministic regardless of how the resolver returns the record.
function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\.+$/, '');
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    await ensureSchemaApplied();
    const user = await requireUser(req, res);
    if (!user) return;
    // 10 lookups per minute per user — DNS is cheap but external.
    if (await enforce(req, res, [{ key: `verify-domain:${user.id}`, max: 10, windowSeconds: 60 }])) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const row = await sql`SELECT id, custom_domain FROM websites WHERE workspace_id = ${workspaceId}`;
    if (row.rows.length === 0 || !row.rows[0].custom_domain) {
      return badRequest(res, 'Set a custom domain first.');
    }
    const domain = norm(row.rows[0].custom_domain);
    let status = 'failed';
    let detail = '';
    try {
      // Match either CNAME or an A-record that aliases to the same host.
      // Prefer CNAME — it's the path we tell owners to use.
      const cnames = await dns.resolveCname(domain).catch(() => []);
      if (cnames.some((c) => norm(c) === norm(TARGET_CNAME))) {
        status = 'verified';
      } else if (cnames.length > 0) {
        status = 'dns_pending';
        detail = `CNAME points to ${cnames.join(', ')} — expected ${TARGET_CNAME}.`;
      } else {
        // No CNAME records at all → owner probably hasn't added it yet.
        status = 'unverified';
        detail = `No CNAME record found for ${domain}. Add a CNAME pointing to ${TARGET_CNAME} and try again.`;
      }
    } catch (e) {
      status = 'failed';
      detail = e.message || 'DNS lookup failed';
    }
    await sql`UPDATE websites SET domain_status = ${status}, updated_at = NOW() WHERE id = ${row.rows[0].id}`;
    return ok(res, {
      domain,
      status,
      detail,
      target: TARGET_CNAME,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
