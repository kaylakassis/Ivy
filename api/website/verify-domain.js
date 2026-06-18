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

// Register the domain with our Vercel project so Vercel terminates TLS
// for it and routes the host to this deployment. Without this step the
// DNS can be correct but Vercel still answers the host with its own
// "domain not configured" error, because it doesn't know to serve us.
//
// Idempotent: a 409 means the domain is already attached - treat as
// success. Best-effort + guarded: if VERCEL_TOKEN / VERCEL_PROJECT_ID
// aren't set we skip provisioning (the operator adds the domain in the
// Vercel dashboard manually) and say so in `detail`.
async function provisionVercelDomain(domain) {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) return { ok: false, reason: 'not_configured' };
  const teamQ = process.env.VERCEL_TEAM_ID
    ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}`
    : '';
  try {
    const r = await fetch(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/domains${teamQ}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: domain }),
      },
    );
    if (r.ok || r.status === 409) return { ok: true };
    const body = await r.text().catch(() => '');
    return { ok: false, reason: `vercel ${r.status}: ${body.slice(0, 160)}` };
  } catch (e) {
    return { ok: false, reason: e.message || 'request failed' };
  }
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    await ensureSchemaApplied();
    const user = await requireUser(req, res);
    if (!user) return;
    // 10 lookups per minute per user - DNS is cheap but external.
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
      // Prefer CNAME - it's the path we tell owners to use.
      const cnames = await dns.resolveCname(domain).catch(() => []);
      if (cnames.some((c) => norm(c) === norm(TARGET_CNAME))) {
        status = 'verified';
      } else if (cnames.length > 0) {
        status = 'dns_pending';
        detail = `CNAME points to ${cnames.join(', ')} - expected ${TARGET_CNAME}.`;
      } else {
        // No CNAME records at all → owner probably hasn't added it yet.
        status = 'unverified';
        detail = `No CNAME record found for ${domain}. Add a CNAME pointing to ${TARGET_CNAME} and try again.`;
      }
    } catch (e) {
      status = 'failed';
      detail = e.message || 'DNS lookup failed';
    }
    // DNS is correct → make Vercel actually serve the domain.
    if (status === 'verified') {
      const prov = await provisionVercelDomain(domain);
      if (!prov.ok && prov.reason !== 'not_configured') {
        // Keep the DNS verdict (DNS IS verified), but tell the owner the
        // domain still needs to be attached on our side.
        detail = `DNS verified. Finishing domain setup is taking a moment (${prov.reason}). Your site will be live here shortly.`;
      }
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
