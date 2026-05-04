// POST /api/admin/email-blast  { segment, subject, html, dryRun? }
//
// Sends one transactional email per recipient in the chosen segment.
// Wraps every send in try/catch so a single bad address doesn't kill
// the run. Returns counts.
//
// Segments mirror the admin Users-tab filters:
//   all              | every user (use sparingly)
//   business-active  | owners with subscription_status = 'active'
//   business-trial   | owners on a live trial
//   sponsored        | user_type = 'sponsored'
//   affiliate        | user_type = 'affiliate'
//   client-only      | claimed clients-row but no workspace
//
// `dryRun: true` returns the recipient count without sending — use it
// before pulling the trigger.
//
// IMPORTANT: this hits Resend with one request per email. For >500
// recipients consider batching with a real broadcast endpoint
// (Resend's audiences API). v1 is fine for the size we're at.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { sendEmail, emailShell } from '../_lib/email.js';
import { recordAudit } from '../_lib/audit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

const SEGMENTS = new Set([
  'all', 'business-active', 'business-trial',
  'sponsored', 'affiliate', 'client-only',
]);
const MAX_BLAST = 2000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const body = await readBody(req);
    const segment = String(body.segment || '');
    const subject = (body.subject || '').toString().trim().slice(0, 200);
    const htmlIn  = (body.html    || '').toString();
    const heading = (body.heading || '').toString().trim().slice(0, 200);
    const dryRun  = !!body.dryRun;

    if (!SEGMENTS.has(segment)) return badRequest(res, 'Unknown segment');
    if (!subject) return badRequest(res, 'Subject is required');
    if (!htmlIn)  return badRequest(res, 'Body is required');

    const recipients = await loadSegment(segment);
    if (recipients.length > MAX_BLAST) {
      return badRequest(res, `Segment has ${recipients.length} recipients — over the per-blast cap of ${MAX_BLAST}.`);
    }
    if (dryRun) {
      return ok(res, { dryRun: true, recipients: recipients.length });
    }

    const html = emailShell({
      heading: heading || subject,
      body: htmlIn,
      footer: `Sent from THRYVE. Reply to this email and we'll see it.`,
    });

    let sent = 0; let failed = 0;
    for (const r of recipients) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await sendEmail({ to: r.email, subject, html });
        sent++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[email-blast] failed for', r.email, err.message);
        failed++;
      }
    }

    const actor = await getAdminActor(req);
    await recordAudit(req, {
      actor, action: 'email_blast',
      meta: { segment, subject, recipients: recipients.length, sent, failed },
    });

    return ok(res, { ok: true, recipients: recipients.length, sent, failed });
  } catch (err) {
    return serverError(res, err);
  }
}

async function loadSegment(segment) {
  // Always require a verified email — we never want to blast unverified
  // addresses (high bounce rate hurts deliverability).
  if (segment === 'all') {
    const r = await sql`
      SELECT id, email, name FROM users
      WHERE email IS NOT NULL AND email_verified_at IS NOT NULL
    `;
    return r.rows;
  }
  if (segment === 'business-active') {
    const r = await sql`
      SELECT u.id, u.email, u.name FROM users u
      JOIN workspaces w ON w.owner_id = u.id
      WHERE w.subscription_status = 'active' AND u.email_verified_at IS NOT NULL
    `;
    return r.rows;
  }
  if (segment === 'business-trial') {
    const r = await sql`
      SELECT u.id, u.email, u.name FROM users u
      JOIN workspaces w ON w.owner_id = u.id
      WHERE w.subscription_status = 'trialing'
        AND w.trial_ends_at > NOW()
        AND u.email_verified_at IS NOT NULL
    `;
    return r.rows;
  }
  if (segment === 'sponsored') {
    const r = await sql`
      SELECT id, email, name FROM users
      WHERE user_type = 'sponsored' AND email_verified_at IS NOT NULL
    `;
    return r.rows;
  }
  if (segment === 'affiliate') {
    const r = await sql`
      SELECT id, email, name FROM users
      WHERE user_type = 'affiliate' AND email_verified_at IS NOT NULL
    `;
    return r.rows;
  }
  if (segment === 'client-only') {
    const r = await sql`
      SELECT u.id, u.email, u.name FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)
        AND EXISTS    (SELECT 1 FROM clients c WHERE c.user_id = u.id)
        AND u.email_verified_at IS NOT NULL
    `;
    return r.rows;
  }
  return [];
}
