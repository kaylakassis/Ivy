// POST /api/website/form-submission
//
// Public — no auth. Accepts contact form / newsletter submissions from
// a published Ivy OS site, finds the owner's matching form destination
// (email or webhook), and delivers. Every submission is also persisted
// in `website_form_submissions` so owners see inbound traffic even when
// the destination temporarily fails.
//
// Body shape:
//   {
//     handle:   "rivers-coaching",     // identifies the site
//     formId:   "contact" | "newsletter" | <custom>,
//     payload:  { ... }                // fields the form collected
//     hp:       "..."                  // honeypot — non-empty = bot
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    await ensureSchemaApplied();
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return badRequest(res, 'Invalid body');

    // Honeypot — bots typically fill every field. Real users leave it
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
      SELECT id, business_name, handle, form_destinations, workspace_id
      FROM websites
      WHERE handle = ${handle} AND published_at IS NOT NULL
    `;
    if (found.rows.length === 0) return badRequest(res, 'Site not found');
    const site = found.rows[0];

    // Record the submission first — that way even if the destination
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
        const r = await fetch(dest.config.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            site: site.handle,
            formId,
            payload,
            submittedAt: new Date().toISOString(),
          }),
        });
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

    return ok(res, { received: true, delivered });
  } catch (err) {
    return serverError(res, err);
  }
}

async function deliverByEmail({ to, site, formId, payload }) {
  const subject = `New ${formId} submission — ${site.business_name || site.handle}`;
  const rows = Object.entries(payload || {}).map(([k, v]) => `
    <tr>
      <td style="padding:8px 12px;color:#5C5A55;font-size:12px;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(k)}</td>
      <td style="padding:8px 12px;color:#1A1A1A;font-size:14px">${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</td>
    </tr>`).join('');
  const html = emailShell({
    heading: 'New form submission',
    body: `Someone submitted your <strong>${escapeHtml(formId)}</strong> form on
      <a href="https://getivyos.com/site/${escapeHtml(site.handle)}">${escapeHtml(site.business_name || site.handle)}</a>.
      <table style="margin-top:18px;border-collapse:collapse;width:100%">${rows}</table>`,
    footer: 'You can change where these go in Editor → Forms.',
  });
  await sendEmail({ to, subject, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
