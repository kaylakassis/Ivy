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
import { sendEmail, sendEmailToUser, emailShell } from '../_lib/email.js';
import { notifyLeadInstantReply, extractLeadContact } from '../_lib/leadNotify.js';
import { fetchWithTimeout } from '../_lib/fetchTimeout.js';
import { assertPublicHttpsUrl } from '../_lib/safeUrl.js';
import { fireClientCreatedWorkflows } from '../_lib/workflows.js';
import { notifyOwnerSafe } from '../_lib/push.js';

// SSRF guard for owner-configured form-webhook delivery. This endpoint is
// PUBLIC (any visitor triggers it), so a delivery URL pointing at the cloud
// metadata endpoint or an internal host would let someone probe our network.
// assertPublicHttpsUrl requires https, refuses private / loopback /
// link-local literals AND resolves the hostname so a public-looking name
// that answers with a private address is refused too. The 5s timeout on
// the call below bounds the blast radius of anything that slips past.

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
        const safeUrl = await assertPublicHttpsUrl(dest.config.url, { what: 'Webhook URL' });
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
        // Default: email the workspace owner, resolved through
        // workspaces.owner_id. (memberships is the client-subscription
        // table and has no user_id; the old join threw every time, so no
        // site without an explicit destination ever delivered a lead.)
        const owner = await sql`
          SELECT u.id, u.email
          FROM workspaces w
          JOIN users u ON u.id = w.owner_id
          WHERE w.id = ${site.workspace_id} AND u.deleted_at IS NULL
          LIMIT 1
        `;
        const to = owner.rows[0]?.email;
        if (to) {
          const outcome = await deliverByEmail({ to, site, formId, payload, ownerUserId: owner.rows[0].id });
          // Muted: the owner turned off message emails. The submission is
          // stored and visible in Ivy; record why no email went out.
          if (outcome === 'muted') deliveryErr = 'Owner turned off message emails';
          else delivered = true;
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
      let leadClientId = null;
      if (leadEmail) {
        // Put the prospect in the owner's CRM as a lead (find-or-create by
        // email within the workspace, like the booking-page contact form)
        // and fire lead_created / client_created workflows for a NEW row
        // only - a returning visitor doesn't re-trigger. Best-effort: a
        // CRM hiccup must never fail a delivered form.
        leadClientId = await recordWebsiteLead({ workspaceId: site.workspace_id, email: leadEmail, name: leadName, handle: site.handle });
        await notifyLeadInstantReply({ workspaceId: site.workspace_id, toEmail: leadEmail, leadName });
      }
      // Owner push: a new enquiry is time-sensitive. The body names the
      // person (from the form) but never echoes the free-text fields, so
      // nothing private sits on a lock screen. Opens the lead's record
      // when one exists, else the inbox of form leads (Clients).
      await notifyOwnerSafe({
        workspaceId: site.workspace_id,
        type: 'messages',
        payload: {
          title: 'New website enquiry',
          body: `${String(leadName || leadEmail || 'Someone').slice(0, 80)} filled in your ${String(formId).slice(0, 40)} form.`,
          url: leadClientId ? `/clients?id=${leadClientId}` : '/clients',
          tag: `form-${submissionId}`,
        },
      });
    }

    return ok(res, { received: true, delivered });
  } catch (err) {
    return serverError(res, err);
  }
}

async function recordWebsiteLead({ workspaceId, email, name, handle }) {
  try {
    const existing = await sql`
      SELECT id FROM clients
       WHERE workspace_id = ${workspaceId} AND lower(email) = ${email}
       LIMIT 1
    `;
    if (existing.rows.length > 0) return existing.rows[0].id;
    // clients.name is NOT NULL - fall back to the address's local part
    // when the form didn't collect a name.
    const clientName = (name || '').trim() || email.split('@')[0];
    const ins = await sql`
      INSERT INTO clients (workspace_id, name, email, stage, source)
      VALUES (${workspaceId}, ${clientName}, ${email}, 'lead', 'Website form')
      RETURNING *
    `;
    await fireClientCreatedWorkflows({ workspaceId, client: ins.rows[0], source: 'website-form' });
    return ins.rows[0].id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[form-submission] lead record failed (${handle}):`, err.message);
    return null;
  }
}

async function deliverByEmail({ to, site, formId, payload, ownerUserId = null }) {
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
  // Owner's own inbox (no explicit destination): a lead notice the owner
  // can mute under Messages emails, so it goes through the preference
  // gate. An explicit destination is an address the owner typed in
  // Editor → Forms for exactly this, so it is delivered as configured.
  if (ownerUserId) {
    const r = await sendEmailToUser({ userId: ownerUserId, type: 'messages', to, subject, html });
    if (r.ok === false) throw new Error(r.reason || 'Email failed');
    return r.sent ? 'sent' : 'muted';
  }
  await sendEmail({ to, subject, html });
  return 'sent';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
