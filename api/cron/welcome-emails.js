// /api/cron/welcome-emails — daily job that walks the welcome sequence.
//
// For each beat (day 1, 3, 7, 14): finds users old enough to receive it
// who haven't received it yet, sends, marks sent. Idempotent — safe to
// re-run, will only send to users with the matching JSONB key missing.
//
// Auth: Vercel cron sends `Authorization: Bearer $CRON_SECRET`. Set
// CRON_SECRET in env so a random caller can't trigger blasts.
//
// Schedule (in vercel.json): once per day at 14:00 UTC (9am ET).
//
// To trigger manually for testing (admin only):
//   curl -X POST https://thryve-pink.vercel.app/api/cron/welcome-emails \
//     -H "x-admin-secret: $ADMIN_SECRET"
import { sql } from '../_lib/db.js';
import { sendEmail } from '../_lib/email.js';
import { appUrl } from '../_lib/tokens.js';
import { reportError } from '../_lib/monitoring.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';
import { WELCOME_BEATS } from '../_lib/welcome-content.js';

const SEQUENCES = Object.entries(WELCOME_BEATS).map(([key, v]) => ({
  key, hours: v.hours, render: v.render,
}));

// Cap per run so a backlog (e.g. first deploy with thousands of stale
// users) doesn't blow past Resend's rate limit. The cron will catch up
// across subsequent days.
const MAX_PER_BEAT = 200;

export default async function handler(req, res) {
  // Allow Vercel cron, the operator's admin secret, OR an in-app trigger
  // from a signed-in super-admin clicking the button in /account → Admin.
  const cronAuth = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    const summary = {};
    for (const seq of SEQUENCES) {
      summary[seq.key] = await processBeat(seq);
    }
    return ok(res, { ok: true, summary });
  } catch (err) {
    reportError(err, { req });
    return serverError(res, err);
  }
}

async function processBeat({ key, hours, render }) {
  // Find users who:
  //   - signed up at least `hours` ago
  //   - don't already have welcome_sent.<key> set
  //   - have a verified email (no point emailing addresses they can't
  //     prove they own; reduces bounce rates too)
  // Also pull workspace ownership + client membership so we can branch
  // the body content per role: owners get the business-app sequence,
  // client-only users get the portal sequence.
  const { rows } = await sql.query(
    `SELECT u.id, u.email, u.name, u.created_at,
            EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id) AS is_owner,
            EXISTS (SELECT 1 FROM clients c WHERE c.user_id = u.id)    AS is_client
       FROM users u
       WHERE u.created_at <= NOW() - ($1 || ' hours')::interval
         AND NOT (u.welcome_sent ? $2)
         AND u.email_verified_at IS NOT NULL
       ORDER BY u.created_at ASC
       LIMIT ${MAX_PER_BEAT}`,
    [String(hours), key],
  );

  let sent = 0;
  let failed = 0;
  for (const user of rows) {
    try {
      // Owners see the owner sequence (run-your-business). Client-only
      // users see the portal sequence (manage your appointments). When
      // the renderer doesn't have a client variant for this beat
      // (e.g. day14 is owner-only), client-only users skip silently —
      // we still mark welcome_sent so we don't re-evaluate them.
      const variant = user.is_owner ? 'owner' : 'client';
      const out = render({ name: firstName(user), appUrl: appUrl(), variant });
      if (out) {
        await sendEmail({ to: user.email, subject: out.subject, html: out.html });
        sent++;
      }
      await sql`
        UPDATE users
        SET welcome_sent = welcome_sent || jsonb_build_object(${key}, NOW()::text)
        WHERE id = ${user.id}
      `;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[welcome ${key}] send failed for ${user.email}:`, err.message);
      reportError(err, { extra: { beat: key, userId: user.id } });
      failed++;
    }
  }
  return { eligible: rows.length, sent, failed };
}

function firstName(user) {
  if (!user.name) return null;
  return String(user.name).trim().split(/\s+/)[0] || null;
}
