// Intake-form auto-attach. When a booking is created for a service that
// has intake_form_template_ids set, we clone each template into a new
// document instance addressed to the booking's client and push it to
// 'sent' status with a fresh sign token. Best-effort - a failure on any
// individual template logs + skips, never blocks the booking.
//
// Called from the booking POST paths (owner-side + public-side) right
// after the bookings INSERT succeeds.
import crypto from 'node:crypto';
import { sql } from './db.js';
import { sendEmailToClient, emailShell } from './email.js';
import { fetchBranding } from './branding.js';
import { appUrl } from './tokens.js';

function generateRawToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function attachIntakeForms({ workspaceId, bookingId }) {
  try {
    const { rows: bRows } = await sql`
      SELECT b.id, b.client_id, b.client_name, b.client_email,
             s.name AS service_name, s.intake_form_template_ids,
             cs.biz_name
      FROM bookings b
      LEFT JOIN services s ON s.id = b.service_id
      LEFT JOIN calendar_settings cs ON cs.workspace_id = b.workspace_id
      WHERE b.id = ${bookingId} AND b.workspace_id = ${workspaceId}
    `;
    const b = bRows[0];
    if (!b) return;
    const templateIds = b.intake_form_template_ids || [];
    if (templateIds.length === 0) return;
    if (!b.client_email) return; // can't send without an inbox

    const { rows: templates } = await sql.query(
      `SELECT * FROM documents
       WHERE id = ANY($1) AND workspace_id = $2 AND is_template = TRUE`,
      [templateIds, workspaceId],
    );

    for (const t of templates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await cloneAndSend({
          workspaceId,
          template: t,
          recipientClientId: b.client_id,
          recipientName:     b.client_name,
          recipientEmail:    b.client_email,
          businessName:      b.biz_name || 'Your business',
          serviceName:       b.service_name || null,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[intake] template ${t.id} failed:`, err.message);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[intake] attach failed for booking', bookingId, err.message);
  }
}

async function cloneAndSend({
  workspaceId, template, recipientClientId, recipientName, recipientEmail,
  businessName, serviceName,
}) {
  const rawToken = generateRawToken(32);
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const initialActivity = [{
    ts: new Date().toISOString(),
    kind: 'sent',
    text: `Sent to ${recipientName} (intake for ${serviceName || 'booking'})`,
  }];

  // Clone the template's payload (content, fields, kind, file ref) into
  // a new instance addressed to the client. status='sent' + sign token
  // primed so the client can sign right away.
  const inserted = await sql`
    INSERT INTO documents (
      workspace_id, name, kind, content_html, file_url, page_count, fields,
      recipient_client_id, recipient_name, recipient_email,
      status, sign_token_hash, sent_at, activity,
      is_template, template_id
    ) VALUES (
      ${workspaceId}, ${template.name}, ${template.kind}, ${template.content_html},
      ${template.file_url}, ${template.page_count}, ${template.fields},
      ${recipientClientId}, ${recipientName}, ${recipientEmail},
      'sent', ${tokenHash}, NOW(), ${JSON.stringify(initialActivity)}::jsonb,
      FALSE, ${template.id}
    )
    RETURNING id
  `;

  const link = `${appUrl()}/sign/${encodeURIComponent(rawToken)}`;
  const branding = await fetchBranding(workspaceId);
  await sendEmailToClient({
    clientId: recipientClientId, type: 'documents',
    to: recipientEmail,
    subject: `Before your appointment - please complete "${template.name}"`,
    replyTo: branding.replyTo,
    html: emailShell({
      heading: 'Quick form to complete before your appointment',
      body: `<p>Hi ${escapeHtml(recipientName)},</p>
        <p>${escapeHtml(businessName)} sent over an intake form to complete
        before your${serviceName ? ` ${escapeHtml(serviceName)}` : ''} appointment:
        <b>${escapeHtml(template.name)}</b>.</p>
        <p>The link below is private to you - please complete it before your session.</p>`,
      ctaText: 'Open and sign',
      ctaUrl: link,
      branding,
    }),
  }).catch(() => { /* best-effort */ });

  return inserted.rows[0].id;
}
