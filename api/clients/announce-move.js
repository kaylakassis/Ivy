// /api/clients/announce-move - after switching to Ivy, email chosen clients
// a short note from the business with its new booking link.
//
//   GET  → { subject, body, bookingUrl, eligibleCount, alreadyAnnouncedCount }
//          body is the ready-to-send plain text with the real booking link;
//          {first name} in it becomes each client's first name ("there"
//          when unknown). eligibleCount = clients with an email who have not
//          opted out and were not told yet.
//   POST { clientIds: [uuid] (max 1000), subject?, body? }
//        → { sent, skipped: { noEmail, optedOut, alreadySent, overCap, failed } }
//          One email per eligible client through sendEmailToClient (type
//          'marketing', so unsubscribes and client_email_optouts are honored
//          and the List-Unsubscribe header is added). Each client gets it at
//          most once (clients.move_announced_at). At most 500 per business
//          per 24 hours. Owner edits are plain text, capped and escaped.
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { sendEmailToClient, emailShell } from '../_lib/email.js';
import { fetchBranding } from '../_lib/branding.js';
import {
  announceContext, defaultSubject, defaultBody, cleanSubject, cleanBody, renderAnnouncement,
  announceCandidates, sentInLastDay, ANNOUNCE_EMAIL_TYPE, ANNOUNCE_DAILY_CAP,
} from '../_lib/moveAnnounce.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MAX_IDS = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, req.method === 'GET'
      ? [{ key: `announce-move:get:ws:${workspaceId}`, max: 120, windowSeconds: 3600 }]
      : [{ key: `announce-move:send:ws:${workspaceId}`, max: 10, windowSeconds: 3600 }])) return;

    const ctx = await announceContext(workspaceId);

    if (req.method === 'GET') {
      const rows = await announceCandidates(workspaceId);
      let eligibleCount = 0;
      let alreadyAnnouncedCount = 0;
      for (const c of rows) {
        if (c.move_announced_at) { alreadyAnnouncedCount++; continue; }
        if (c.email && !c.opted_out) eligibleCount++;
      }
      return ok(res, {
        subject: defaultSubject(ctx.businessName),
        body: defaultBody(ctx),
        bookingUrl: ctx.bookingUrl,
        eligibleCount,
        alreadyAnnouncedCount,
      });
    }

    const body = await readBody(req);
    if (!Array.isArray(body?.clientIds) || body.clientIds.length === 0) return badRequest(res, 'Choose at least one client.');
    if (body.clientIds.length > MAX_IDS) return badRequest(res, `Choose at most ${MAX_IDS} clients at a time.`);
    if (!ctx.bookingUrl) return badRequest(res, 'Set up your booking page first, so there is a link to share.');
    const ids = [...new Set(body.clientIds.filter((x) => typeof x === 'string' && UUID_RE.test(x)).map((x) => x.toLowerCase()))];
    const subject = cleanSubject(body.subject) || defaultSubject(ctx.businessName);
    const text = cleanBody(body.body) || defaultBody(ctx);

    const skipped = { noEmail: 0, optedOut: 0, alreadySent: 0, overCap: 0, failed: 0 };
    let sent = 0;
    if (!ids.length) return ok(res, { sent, skipped });

    const rows = await announceCandidates(workspaceId, ids);
    const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
    let remaining = Math.max(0, ANNOUNCE_DAILY_CAP - await sentInLastDay(workspaceId));
    const branding = await fetchBranding(workspaceId);

    for (const id of ids) {
      const c = byId.get(id);
      if (!c) continue; // not this business's client: ignored
      if (!c.email) { skipped.noEmail++; continue; }
      if (c.move_announced_at) { skipped.alreadySent++; continue; }
      if (c.opted_out) { skipped.optedOut++; continue; }
      if (remaining <= 0) { skipped.overCap++; continue; }
      // Claim first so two tabs can never send the same client twice.
      const claim = await sql`
        UPDATE clients SET move_announced_at = NOW()
         WHERE id = ${c.id} AND workspace_id = ${workspaceId} AND move_announced_at IS NULL
         RETURNING id`;
      if (!claim.rows.length) { skipped.alreadySent++; continue; }
      const msg = renderAnnouncement(text, { clientName: c.name, bookingUrl: ctx.bookingUrl });
      const out = await sendEmailToClient({
        clientId: c.id,
        type: ANNOUNCE_EMAIL_TYPE,
        to: c.email,
        subject,
        replyTo: branding.replyTo || ctx.replyTo || undefined,
        text: msg.text,
        html: emailShell({
          heading: subject,
          body: msg.html,
          ctaText: 'Book now',
          ctaUrl: ctx.bookingUrl,
          branding,
        }),
      });
      if (out?.sent) { sent++; remaining--; continue; }
      // Not sent: release the claim so they can be sent it later.
      await sql`UPDATE clients SET move_announced_at = NULL WHERE id = ${c.id} AND workspace_id = ${workspaceId}`;
      if (out?.reason === 'muted') skipped.optedOut++;
      else if (out?.reason === 'workspace-quota-exceeded') { skipped.overCap++; remaining = 0; }
      else skipped.failed++;
    }
    return ok(res, { sent, skipped });
  } catch (err) {
    return serverError(res, err);
  }
}
