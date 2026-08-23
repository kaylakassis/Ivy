// POST /api/admin/waitlist-announce  { subject?, heading?, body?, dryRun? }
//
// Emails the launch announcement to every waitlist signup that hasn't
// been notified yet (notified_at IS NULL), then stamps notified_at so a
// re-run never double-sends. Super-admin only. Mirrors email-blast.js:
// batched 20-concurrent Promise.allSettled, a 5-minute cooldown, audited.
//
// Recipients are NOT users (they only joined the waitlist), so we send
// via the raw sendEmail wrapper rather than the user-scoped sender.
// They explicitly opted in, so there's no per-user preference to honor.
//
// The default copy tells recipients to sign up with the SAME email they
// waitlisted with — that's how the 20%/12mo discount auto-applies. Pass
// `dryRun: true` to get the pending recipient count without sending.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { appUrl } from '../_lib/tokens.js';
import { recordAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const MAX_ANNOUNCE = 5000;
const COOLDOWN_MS = 5 * 60 * 1000;
const BATCH = 20;

const DEFAULT_SUBJECT = 'Ivy is live — claim your 20% founding discount';
const DEFAULT_HEADING = "We're live 🎉";
const DEFAULT_BODY = `
  <p>Thanks for being on the Ivy waitlist. The doors are open — you can sign up now.</p>
  <p><b>Your founding-member perk:</b> sign up with <b>this same email address</b> and you'll
  automatically get <b>20% off for your first 12 months</b>. No code needed — it applies at checkout.</p>
  <p>Welcome aboard 👋</p>
`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const body = await readBody(req);
    const subject = (body.subject || DEFAULT_SUBJECT).toString().trim().slice(0, 200);
    const heading = (body.heading || DEFAULT_HEADING).toString().trim().slice(0, 200);
    const htmlBody = (body.body || DEFAULT_BODY).toString();
    const dryRun = !!body.dryRun;

    // Cooldown (skip for dryRun) — same fat-finger guard as email-blast.
    if (!dryRun) {
      const actorPreview = await getAdminActor(req);
      if (actorPreview?.id) {
        try {
          const recent = await sql`
            SELECT created_at FROM audit_events
            WHERE actor_user_id = ${actorPreview.id}
              AND action = 'waitlist_announce'
              AND created_at >= NOW() - (${Math.ceil(COOLDOWN_MS / 1000)} || ' seconds')::interval
            ORDER BY created_at DESC LIMIT 1
          `;
          if (recent.rows[0]) {
            const sinceMs = Date.now() - new Date(recent.rows[0].created_at).getTime();
            const waitS = Math.max(1, Math.ceil((COOLDOWN_MS - sinceMs) / 1000));
            return badRequest(res, `Cooldown - wait ${waitS}s before announcing again.`);
          }
        } catch (e) {
          console.warn('[waitlist-announce] cooldown check skipped:', e.message);
        }
      }
    }

    const { rows: recipients } = await sql`
      SELECT id, email, name FROM waitlist_signups
      WHERE notified_at IS NULL
      ORDER BY created_at ASC
      LIMIT ${MAX_ANNOUNCE}
    `;
    if (dryRun) return ok(res, { dryRun: true, recipients: recipients.length });
    if (recipients.length === 0) return ok(res, { ok: true, recipients: 0, sent: 0, failed: 0 });

    const html = emailShell({
      heading,
      body: htmlBody,
      ctaText: 'Claim your discount',
      ctaUrl: `${appUrl()}/signup`,
      footer: 'You received this because you joined the Ivy waitlist.',
    });

    let sent = 0; let failed = 0;
    const sentIds = [];
    for (let i = 0; i < recipients.length; i += BATCH) {
      const slice = recipients.slice(i, i + BATCH);
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled(
        slice.map((r) => sendEmail({ to: r.email, subject, html })),
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') { sent++; sentIds.push(slice[j].id); }
        else {
          failed++;
          // eslint-disable-next-line no-console
          console.warn('[waitlist-announce] failed for', slice[j].email, results[j].reason?.message);
        }
      }
    }

    // Stamp only the ones that actually sent, so a partial failure
    // (Resend blip) leaves the rest pending for the next run.
    if (sentIds.length > 0) {
      await sql.query(
        `UPDATE waitlist_signups
            SET status = CASE WHEN status = 'pending' THEN 'notified' ELSE status END,
                notified_at = NOW()
          WHERE id = ANY($1::uuid[]) AND notified_at IS NULL`,
        [sentIds],
      );
    }

    const actor = await getAdminActor(req);
    await recordAudit(req, {
      actor, action: 'waitlist_announce',
      meta: { recipients: recipients.length, sent, failed },
    });

    return ok(res, { ok: true, recipients: recipients.length, sent, failed });
  } catch (err) {
    return serverError(res, err);
  }
}
