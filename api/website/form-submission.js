// POST /api/website/form-submission
//
// Public - no auth. Accepts contact form / newsletter submissions from
// a published Ivy site, finds the owner's matching form destination
// (email or webhook), and delivers. Every submission is also persisted
// in `website_form_submissions` so owners see inbound traffic even when
// the destination temporarily fails.
//
// Body shape:
//   {
//     handle:   "rivers-coaching",     // identifies the site
//     formId:   "contact" | "newsletter" | <custom>,
//     payload:  { ... }                // fields the form collected
//     hp:       "..."                  // honeypot - non-empty = bot
//   }
//
// Spam controls: a hidden honeypot field (`hp`) that real users leave
// empty + a per-IP rate limit of 5 submissions / hour.

import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { enforce, getClientIp } from '../_lib/rate-limit.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { notifyLeadInstantReply, extractLeadContact } from '../_lib/leadNotify.js';
import { fetchWithTimeout } from '../_lib/fetchTimeout.js';

// SSRF guard for owner-configured form-webhook delivery. This endpoint is
// PUBLIC (any visitor triggers it), so a delivery URL pointing at the cloud
// metadata endpoint or an internal host would let someone probe our network.
// Require https and reject loopback / link-local / RFC-1918 literals. (Full
// DNS-rebinding protection would need resolve-then-pin; the 5s timeout on the
// call below bounds the blast radius of anything that slips past.)
function assertPublicHttpsUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('Invalid webhook URL'); }
  if (u.protocol !== 'https:') throw new Error('Webhook URL must use https');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    throw new Error('Webhook URL not allowed');
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10 || a >= 224
        || (a === 169 && b === 254)              // link-local incl. 169.254.169.254 metadata
        || (a === 192 && b === 168)
        || (a === 172 && b >= 16 && b <= 31)) {
      throw new Error('Webhook URL not allowed');
    }
  }
  return u.toString();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    await ensureSchemaApplied();
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return badRequest(res, 'Invalid body');

    // Honeypot - bots typically fill every field. Real users leave it
    // empty. Silent-accept (200 OK) so the bot's behavior signal is
    // hidden, but skip all downstream work.
    if (body.hp) return ok(res, { received: true });

    const handle  = String(body.handle || '').toLowerCase().trim();
    const formId  = String(body.formId || 'contact').slice(0, 64);
    const payload = body.payload && typeof body.payload === 'object' ? body.payload : null;
    if (!handle || !payload) return badRequest(res, 'handle + payload are required');

    // Cap payload size to keep abuse cheap. 8KB JSON is generous for a
    // form; anything bigger is probably an attack or an accidental file
    // upload (forms shouldn't carry files via this endpoint).
    if (JSON.stringify(payload).length > 8000) return badRequest(res, 'Payload too large');

    // 5 submissions per IP per hour. Honest users hit forms once.
    const ip = getClientIp(req);
    if (await enforce(req, res, [{ key: `form:${ip}`, max: 5, windowSeconds: 3600 }])) return;

    const found = await sql`
      SELECT id, business_name, handle, form_destinations, workspace_id,
             custom_domain, domain_status
      FROM websites
      WHERE handle = ${handle} AND published_at IS NOT NULL
    `;
    if (found.rows.length === 0) return badRequest(res, 'Site not found');
    const site = found.rows[0];

    // Record the submission first - that way even if the destination
    // fails the owner can still see the data on their next login.
    const inserted = await sql`
      INSERT INTO website_form_submissions (website_id, form_id, payload)
      VALUES (${site.id}, ${formId}, ${JSON.stringify(payload)}::jsonb)
      RETURNING id
    `;
    const submissionId = inserted.rows[0].id;

    // Look up the destination for this formId. If none is configured,
    // fall back to "email the workspace owner". That way a site that's
    // published without explicit form setup still delivers leads.
    const dests = Array.isArray(site.form_destinations) ? site.form_destinations : [];
    const dest = dests.find((d) => d && d.formId === formId);

    let deliveryErr = null;
    let delivered  = false;
    try {
      if (dest && dest.type === 'webhook' && dest.config?.url) {
        const safeUrl = assertPublicHttpsUrl(dest.config.url);
        const r = await fetchWithTimeout(safeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            site: site.handle,
            formId,
            payload,
            submittedAt: new Date().toISOString(),
          }),
        }, 5000);
        if (!r.ok) throw new Error(`Webhook returned ${r.status}`);
        delivered = true;
      } else if (dest && dest.type === 'email' && dest.config?.to) {
        await deliverByEmail({ to: dest.config.to, site, formId, payload });
        delivered = true;
      } else {
        // Default: email the workspace owner. We fetch their email
        // through the users table joined via memberships.
        const owner = await sql`
          SELECT u.email
          FROM users u
          JOIN memberships m ON m.user_id = u.id
          WHERE m.workspace_id = ${site.workspace_id}
          ORDER BY u.created_at ASC
          LIMIT 1
        `;
        const to = owner.rows[0]?.email;
        if (to) {
          await deliverByEmail({ to, site, formId, payload });
          delivered = true;
        } else {
          deliveryErr = 'No destination configured + no workspace owner email';
        }
      }
    } catch (e) {
      deliveryErr = e.message || 'Delivery failed';
    }

    await sql`
      UPDATE website_form_submissions
      SET delivered = ${delivered}, delivery_err = ${deliveryErr}
      WHERE id = ${submissionId}
    `;

    // Instant lead reply: acknowledge the prospect right away with the
    // booking link (per-workspace toggle, default on). Skip the newsletter
    // form - a "thanks for reaching out" reply makes no sense for a
    // subscribe box. Best-effort; never blocks the 200.
    if (formId !== 'newsletter' && site.workspace_id) {
      const { email: leadEmail, name: leadName } = extractLeadContact(payload);
      if (leadEmail) {
        await notifyLeadInstantReply({ workspaceId: site.workspace_id, toEmail: leadEmail, leadName });
      }
    }

    return ok(res, { received: true, delivered });
  } catch (err) {
    return serverError(res, err);
  }
}

async function deliverByEmail({ to, site, formId, payload }) {
  const subject = `New ${formId} submission - ${site.business_name || site.handle}`;
  // Link to the site the way the owner brands it: their verified custom
  // domain when connected, the platform URL otherwise.
  const siteUrl = site.custom_domain && site.domain_status === 'verified'
    ? `https://${String(site.custom_domain).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
    : `https://joinivy.ai/site/${site.handle}`;
  const rows = Object.entries(payload || {}).map(([k, v]) => `
    <tr>
      <td style="padding:8px 12px;color:#5C5A55;font-size:12px;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(k)}</td>
      <td style="padding:8px 12px;color:#1A1A1A;font-size:14px">${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</td>
    </tr>`).join('');
  const html = emailShell({
    heading: 'New form submission',
    body: `Someone submitted your <strong>${escapeHtml(formId)}</strong> form on
      <a href="${escapeHtml(siteUrl)}">${escapeHtml(site.business_name || site.handle)}</a>.
      <table style="margin-top:18px;border-collapse:collapse;width:100%">${rows}</table>`,
    footer: 'You can change where these go in Editor → Forms.',
  });
  await sendEmail({ to, subject, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
