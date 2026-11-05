// /api/cancellation-policy/public  (no sign-in)
//   GET ?slug=<booking page handle>   → the business's current policy
//   GET ?site=<website handle>        → same, looked up by website
//   GET ?token=<link token>           → the policy plus the booking an owner
//                                       asked this client to accept it for
//   POST ?token=<link token>  body { policyAccepted: true, policyVersionId, name? }
//                                     → records the acceptance (source
//                                       'emailed_link'); a link works once
//
// Only text the owner chose to publish is returned. Deleted or archived
// businesses return nothing. Rate limited per IP.
import crypto from 'node:crypto';
import { sql, warmupDbOnce } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { requireSameOrigin } from '../_lib/security.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { loadWorkspaceAccess } from '../_lib/businessAccess.js';
import {
  publicPolicy, getCurrentPolicy, getPolicySettings, recordAcceptance, feeTerms, workspaceCurrency,
} from '../_lib/cancellationPolicy.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

async function workspaceBySlug(slug) {
  const { rows } = await sql`
    SELECT cs.workspace_id, cs.biz_name, cs.slug FROM calendar_settings cs
      JOIN workspaces w ON w.id = cs.workspace_id
      JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
     WHERE cs.slug = ${slug} LIMIT 1
  `;
  return rows[0] || null;
}

async function workspaceBySite(handle) {
  const { rows } = await sql`
    SELECT web.workspace_id, COALESCE(cs.biz_name, web.business_name) AS biz_name, cs.slug
      FROM websites web
      JOIN workspaces w ON w.id = web.workspace_id
      JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
      LEFT JOIN calendar_settings cs ON cs.workspace_id = web.workspace_id
     WHERE web.handle = ${handle} LIMIT 1
  `;
  return rows[0] || null;
}

async function requestByToken(raw) {
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const { rows } = await sql`
    SELECT r.*, cs.biz_name, cs.slug, cs.timezone,
           c.name AS client_name, c.email AS client_email,
           b.date AS b_date, b.start_min, b.end_min, b.booking_total, b.deposit_required,
           b.service_id, b.cancelled_at
      FROM cancellation_policy_requests r
      JOIN workspaces w ON w.id = r.workspace_id
      JOIN users u ON u.id = w.owner_id AND u.deleted_at IS NULL
      LEFT JOIN calendar_settings cs ON cs.workspace_id = r.workspace_id
      LEFT JOIN clients c ON c.id = r.client_id AND c.workspace_id = r.workspace_id
      LEFT JOIN bookings b ON b.id = r.booking_id AND b.workspace_id = r.workspace_id
     WHERE r.token_hash = ${hash} LIMIT 1
  `;
  return rows[0] || null;
}

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null));

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (req.method === 'POST' && !requireSameOrigin(req, res)) return;
  try {
    await warmupDbOnce();
    await ensureSchemaApplied();
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `cpolicy-pub:ip:${ip}`, max: req.method === 'POST' ? 20 : 120, windowSeconds: 600 }])) return;

    const token = typeof req.query.token === 'string' ? req.query.token : null;
    if (token) {
      if (!TOKEN.test(token)) return notFound(res, 'This link is not valid.');
      const r = await requestByToken(token);
      if (!r || new Date(r.expires_at).getTime() < Date.now()) return notFound(res, 'This link has expired. Ask the business to send a new one.');
      const access = await loadWorkspaceAccess(r.workspace_id);
      if (!access.active) return notFound(res, 'This business is no longer taking bookings on Ivy.');
      const policy = await getCurrentPolicy(r.workspace_id);
      if (!policy) return notFound(res, 'There is no cancellation policy to accept yet.');
      const appointment = r.booking_id && r.b_date ? { date: iso(r.b_date), startMin: r.start_min, endMin: r.end_min, timezone: r.timezone || null } : null;

      if (req.method === 'GET') {
        return ok(res, {
          businessName: r.biz_name || '',
          bookingSlug: r.slug || null,
          policy: { versionId: policy.id, version: policy.version, text: policy.text, updatedAt: policy.createdAt },
          request: {
            clientFirstName: String(r.client_name || '').trim().split(/\s+/)[0] || null,
            appointment,
            accepted: !!r.accepted_at,
          },
        });
      }

      const body = await readBody(req);
      if (body?.policyAccepted !== true) return badRequest(res, 'Please tick the box to agree to the cancellation policy.');
      if (body.policyVersionId && String(body.policyVersionId) !== policy.id) {
        return res.status(409).json({
          error: 'The cancellation policy was just updated. Please read the new version and agree again.',
          policy: { versionId: policy.id, version: policy.version, text: policy.text, updatedAt: policy.createdAt },
        });
      }
      // One use per link: the claim and the record happen once.
      const claim = await sql`
        UPDATE cancellation_policy_requests SET accepted_at = NOW()
         WHERE id = ${r.id} AND accepted_at IS NULL RETURNING id
      `;
      if (claim.rows.length === 0) return ok(res, { accepted: true, already: true });
      let service = null;
      if (r.service_id) {
        service = (await sql`SELECT * FROM services WHERE id = ${r.service_id} AND workspace_id = ${r.workspace_id}`).rows[0] || null;
      }
      const settings = await getPolicySettings(r.workspace_id);
      await recordAcceptance({
        workspaceId: r.workspace_id, clientId: r.client_id, bookingId: r.booking_id || null,
        policy, status: 'accepted', source: 'emailed_link', req,
        name: typeof body.name === 'string' && body.name.trim() ? body.name : r.client_name,
        email: r.client_email,
        terms: feeTerms({
          service: service || {}, bookingTotal: r.booking_total == null ? null : Number(r.booking_total),
          currency: await workspaceCurrency(r.workspace_id), settings,
          depositRequired: r.deposit_required == null ? null : Number(r.deposit_required),
          appointment,
        }),
      });
      return ok(res, { accepted: true });
    }

    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
    const slug = typeof req.query.slug === 'string' ? req.query.slug.toLowerCase() : '';
    const site = typeof req.query.site === 'string' ? req.query.site.toLowerCase() : '';
    let ws = null;
    if (slug && HANDLE.test(slug)) ws = await workspaceBySlug(slug);
    else if (site && HANDLE.test(site)) ws = await workspaceBySite(site);
    if (!ws) return notFound(res, 'No cancellation policy here.');
    const access = await loadWorkspaceAccess(ws.workspace_id);
    if (!access.active) return notFound(res, 'No cancellation policy here.');
    const policy = await publicPolicy(ws.workspace_id);
    return ok(res, {
      businessName: ws.biz_name || '',
      bookingSlug: ws.slug || null,
      policy: policy ? {
        versionId: policy.versionId, version: policy.version, text: policy.text, updatedAt: policy.updatedAt,
        showInSiteFooter: policy.showInSiteFooter, showOnBookingPage: policy.showOnBookingPage,
        refundDepositOutsideWindow: policy.refundDepositOutsideWindow,
      } : null,
    });
  } catch (err) {
    return serverError(res, err);
  }
}
