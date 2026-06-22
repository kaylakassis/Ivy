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
// `dryRun: true` returns the recipient count without sending - use it
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
  'sponsored', 'beta', 'affiliate', 'client-only',
]);
const MAX_BLAST = 2000;
// Cooldown between blasts to prevent fat-finger double-sends + protect
// the shared Resend rate limit. Five minutes is enough to notice a
// misfire ("oops, wrong segment") before a second send goes out.
const BLAST_COOLDOWN_MS = 5 * 60 * 1000;

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

    // Cooldown: refuse a second blast from the same admin within
    // BLAST_COOLDOWN_MS. Catches fat-finger double-sends + protects the
    // shared Resend rate limit. The audit-events table already records
    // every blast, so we just check the most recent one. dryRun
    // is exempt so the admin can preview-then-send without waiting.
    if (!dryRun) {
      const actorPreview = await getAdminActor(req);
      if (actorPreview?.id) {
        try {
          const recent = await sql`
            SELECT created_at FROM audit_events
            WHERE actor_user_id = ${actorPreview.id}
              AND action = 'email_blast'
              AND created_at >= NOW() - (${Math.ceil(BLAST_COOLDOWN_MS / 1000)} || ' seconds')::interval
            ORDER BY created_at DESC
            LIMIT 1
          `;
          if (recent.rows[0]) {
            const sinceMs = Date.now() - new Date(recent.rows[0].created_at).getTime();
            const waitS = Math.max(1, Math.ceil((BLAST_COOLDOWN_MS - sinceMs) / 1000));
            return badRequest(res, `Cooldown - wait ${waitS}s before sending another blast (you sent one ${Math.floor(sinceMs / 1000)}s ago).`);
          }
        } catch (e) {
          // audit_events absent on older deploys - skip the cooldown
          // check rather than fail-closed. Logged for visibility.
          console.warn('[email-blast] cooldown check skipped:', e.message);
        }
      }
    }

    const recipients = await loadSegment(segment);
    if (recipients.length > MAX_BLAST) {
      return badRequest(res, `Segment has ${recipients.length} recipients - over the per-blast cap of ${MAX_BLAST}.`);
    }
    if (dryRun) {
      return ok(res, { dryRun: true, recipients: recipients.length });
    }

    const html = emailShell({
      heading: heading || subject,
      body: htmlIn,
      footer: `Sent from Ivy OS. Reply to this email and we'll see it.`,
    });

    // Batched parallel sends. Serial at 200ms/email × 2000 = 400s,
    // far past the 60s function timeout. 20-at-a-time keeps us well
    // under Resend's burst limit (10/s on the free tier, 100/s paid)
    // while finishing 2000 sends in ~20s of wall time.
    let sent = 0; let failed = 0;
    const BATCH = 20;
    for (let i = 0; i < recipients.length; i += BATCH) {
      const slice = recipients.slice(i, i + BATCH);
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.allSettled(
        slice.map((r) => sendEmail({ to: r.email, subject, html })),
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          sent++;
        } else {
          failed++;
          // eslint-disable-next-line no-console
          console.warn('[email-blast] failed for', slice[j].email, results[j].reason?.message || results[j].reason);
        }
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
  // Always require a verified email - we never want to blast unverified
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
  if (segment === 'beta') {
    const r = await sql`
      SELECT id, email, name FROM users
      WHERE user_type = 'beta' AND email_verified_at IS NOT NULL
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
