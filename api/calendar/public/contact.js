// POST /api/calendar/public/contact?slug=<slug>
//
// Public, no-auth "message before booking" entry point. Lets a
// prospect ask a question without committing to a slot:
//   1. Find the workspace by slug (404 if private/missing).
//   2. Find or create a clients row for the prospect's email — stage
//      defaults to 'lead' and source='public-contact' so the owner
//      sees them in their CRM as an inbound lead.
//   3. Find or create the (workspace, client) message thread.
//   4. Insert the message with sender='client', preview the thread,
//      bump unread_biz so it shows in the owner's inbox badge.
//   5. Email + push the owner ("New message from a prospect").
//
// Lives as a static sibling to [slug].js so Vercel routes static
// /api/calendar/public/contact here, and the dynamic [slug].js
// catches everything else under /api/calendar/public/.
import { sql } from '../../_lib/db.js';
import { readBody } from '../../_lib/body.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { validEmail } from '../../_lib/auth.js';
import { sendEmail, emailShell } from '../../_lib/email.js';
import { fetchBranding } from '../../_lib/branding.js';
import { notifyOwnerSafe } from '../../_lib/push.js';
import { appUrl } from '../../_lib/tokens.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  try {
    try { await ensureSchemaApplied(); } catch { /* tolerate */ }
    const slug = (req.query.slug || '').toString().toLowerCase();
    if (!slug) return badRequest(res, 'slug is required');

    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [
      { key: `contact:ip:${ip}`,     max: 10, windowSeconds: 60 * 60 },
      { key: `contact:slug:${slug}`, max: 60, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const settings = await sql`
      SELECT workspace_id FROM calendar_settings WHERE slug = ${slug}
    `;
    if (settings.rows.length === 0) return notFound(res, 'No booking page for that handle');
    const workspaceId = settings.rows[0].workspace_id;

    const body = await readBody(req);
    const name  = (body.name || '').toString().trim().slice(0, 200);
    const email = (body.email || '').toString().trim().toLowerCase().slice(0, 200);
    const text  = (body.message || '').toString().trim();
    if (!name)  return badRequest(res, 'Please share your name.');
    if (!email || !validEmail(email)) return badRequest(res, 'A valid email is required.');
    if (!text)  return badRequest(res, 'Please write a message.');
    if (text.length > 4000) return badRequest(res, 'Message is too long (4000 char max).');

    // Find or create the lead client row by email within this workspace.
    // We don't link to user_id here — that happens at signup if the
    // prospect later claims a portal account using the same email.
    let clientId = null;
    const existing = await sql`
      SELECT id, name, email FROM clients
       WHERE workspace_id = ${workspaceId}
         AND lower(email) = ${email}
       LIMIT 1
    `;
    if (existing.rows.length > 0) {
      clientId = existing.rows[0].id;
      // Backfill the name if we had nothing on file (saves the owner
      // a tap later). Defense-in-depth: re-include workspace_id on
      // the UPDATE so the public-contact flow can never write to a
      // client row outside the workspace it's posting for.
      if (!existing.rows[0].name && name) {
        await sql`
          UPDATE clients SET name = ${name}, updated_at = NOW()
           WHERE id = ${clientId} AND workspace_id = ${workspaceId}
        `;
      }
    } else {
      const ins = await sql`
        INSERT INTO clients (workspace_id, name, email, stage, source)
        VALUES (${workspaceId}, ${name}, ${email}, 'lead', 'public-contact')
        RETURNING *
      `;
      clientId = ins.rows[0].id;
      // Deliberately DO NOT fire lead_created / client_created workflows
      // from the public-contact path. This is a prospect asking a
      // question, not a confirmed onboarding — letting an auto-responder
      // (e.g. the "Instant lead reply" template) speak for the owner
      // robs them of the chance to answer personally, which is the
      // entire point of an inbound question. The owner still gets the
      // notification email + push below and can reply from Messages.
      // Workflows still fire from the real client-creation paths
      // (booking confirmation, owner-side add, CSV import).
    }

    // Find or create the thread for (workspace, client). The two-way
    // mode default lets the owner reply normally.
    const tIns = await sql`
      INSERT INTO message_threads (workspace_id, client_id)
      VALUES (${workspaceId}, ${clientId})
      ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
      RETURNING id
    `;
    const threadId = tIns.rows[0].id;

    // Insert the message. sender='client'. kind='public-contact' so
    // the owner can tell prospect-inbox messages from claimed-portal-
    // client messages at a glance.
    await sql`
      INSERT INTO messages (thread_id, sender, text, kind, meta)
      VALUES (${threadId}, 'client', ${text}, 'public-contact',
              ${JSON.stringify({ ip, source: 'public-contact' })}::jsonb)
    `;
    const preview = text.slice(0, 200);
    await sql`
      UPDATE message_threads SET
        last_message_at      = NOW(),
        last_message_preview = ${preview},
        unread_biz           = unread_biz + 1
       WHERE id = ${threadId}
    `;

    // Notify the owner — push (if subscribed) + email (always).
    notifyOwnerSafe({
      workspaceId,
      type: 'messages',
      payload: {
        title: `New message from ${name}`,
        body: preview,
        url: `/messages?threadId=${threadId}`,
        tag: `prospect-${threadId}`,
      },
    });

    try {
      const branding = await fetchBranding(workspaceId);
      // Owner's email is on workspaces.owner_id → users.
      const owner = await sql`
        SELECT u.email, u.name FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE w.id = ${workspaceId}
      `;
      const ownerEmail = owner.rows[0]?.email;
      if (ownerEmail) {
        await sendEmail({
          to: ownerEmail,
          subject: `New message from ${name}: question about booking`,
          // Set replyTo to the prospect — owner can hit Reply in their
          // mail client to respond directly without opening the app.
          replyTo: email,
          html: emailShell({
            heading: 'A prospect just messaged you',
            body: `<p>Hi ${escapeHtml((owner.rows[0]?.name || '').split(/\s+/)[0] || '')},</p>
              <p><strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(email)}&gt; sent you a message before booking:</p>
              <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #C7BFA8;background:#F6F5F1;border-radius:6px;font-size:14px;line-height:1.55;color:#3F3D38;white-space:pre-wrap;">${escapeHtml(text)}</blockquote>
              <p>This conversation is now in your Messages inbox under <strong>${escapeHtml(name)}</strong> — replying there sends them an email.</p>`,
            ctaText: 'Open conversation',
            ctaUrl: `${appUrl()}/messages?threadId=${threadId}`,
            footer: `Replying to this email goes straight to ${escapeHtml(name)}. The conversation is also tracked in your Ivy OS Messages inbox.`,
            branding,
          }),
        });
      }
    } catch (mailErr) {
      // eslint-disable-next-line no-console
      console.error('[public-contact] owner email failed:', mailErr.message);
    }

    return ok(res, { ok: true, threadId });
  } catch (err) {
    return serverError(res, err);
  }
}
