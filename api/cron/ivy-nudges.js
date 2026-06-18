// /api/cron/ivy-nudges - owner-side "things are getting quiet" pings.
//
// Two detectors:
//   1. AWAITING_REPLY - a 1:1 message_threads row with unread_biz > 0
//      whose last_message_at is older than NUDGE_REPLY_HOURS. Owner
//      forgot to respond - Ivy nudges with a deep-link that prompts
//      her to draft something.
//   2. GONE_QUIET - a client who was active in the last 90 days but
//      whose latest activity (booking, message, invoice) is older
//      than NUDGE_QUIET_DAYS. The "check in with X" prompt.
//
// Dedup per (workspace, client, kind) via ivy_nudges_fired so a single
// situation doesn't re-fire daily. COOLDOWN_DAYS clears the row so a
// later re-occurrence can fire again.
//
// Hard caps per run keep a misconfigured workspace from blowing the
// cron's notification budget.
import { sql } from '../_lib/db.js';
import { isSuperAdminBySession } from '../_lib/admin.js';
import { notifyOwnerSafe } from '../_lib/push.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

const NUDGE_REPLY_HOURS = 24;
const NUDGE_QUIET_DAYS  = 14;
const ACTIVE_WINDOW_DAYS = 90;   // only nudge about clients who were active recently
const COOLDOWN_DAYS     = 7;     // don't re-fire the same nudge for COOLDOWN_DAYS
const MAX_PER_RUN       = 500;

async function handler(req, res) {
  const cronAuth = !!process.env.CRON_SECRET
    && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const adminAuth = process.env.ADMIN_SECRET
    && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET;
  const userAuth = !cronAuth && !adminAuth ? await isSuperAdminBySession(req) : false;
  if (!cronAuth && !adminAuth && !userAuth) return unauthorized(res);

  try {
    // Clear cooldowns past COOLDOWN_DAYS so the same kind can re-fire
    // if the situation re-occurs. Done first so the joins below skip
    // anything still cooling down.
    await sql`
      DELETE FROM ivy_nudges_fired
       WHERE fired_at < NOW() - (${COOLDOWN_DAYS} || ' days')::interval
    `;

    // ─── 1. Awaiting reply ──────────────────────────────────────────
    // Owner hasn't responded to a client message for NUDGE_REPLY_HOURS.
    // unread_biz > 0 means the LAST inbound was from the client; we
    // also require last_message_at > workspace cap.
    const awaiting = await sql`
      SELECT t.workspace_id, t.client_id, t.id AS thread_id,
             t.last_message_at, t.last_message_preview,
             c.name AS client_name
        FROM message_threads t
        JOIN clients c ON c.id = t.client_id AND c.workspace_id = t.workspace_id
        LEFT JOIN ivy_nudges_fired n
          ON n.workspace_id = t.workspace_id
         AND n.client_id    = t.client_id
         AND n.kind         = 'awaiting_reply'
       WHERE t.unread_biz > 0
         AND t.last_message_at IS NOT NULL
         AND t.last_message_at <= NOW() - (${NUDGE_REPLY_HOURS} || ' hours')::interval
         AND n.workspace_id IS NULL
       ORDER BY t.last_message_at ASC
       LIMIT ${MAX_PER_RUN}
    `;

    let awaitingFired = 0;
    for (const r of awaiting.rows) {
      try {
        // The deep-link drops the owner into Ivy with a draft prompt
        // for this thread - turning the nudge into a one-tap action.
        const draftPrompt = `Help me draft a warm reply to ${r.client_name || 'this client'} (open thread). They wrote: "${(r.last_message_preview || '').slice(0, 120)}"`;
        notifyOwnerSafe({
          workspaceId: r.workspace_id, type: 'messages',
          payload: {
            title: 'Ivy · waiting on your reply',
            body: `${r.client_name || 'A client'} messaged ${humanAgo(r.last_message_at)}.`,
            url: `/ivy?prompt=${encodeURIComponent(draftPrompt)}`,
            tag: `ivy-awaiting-${r.client_id}`,
          },
        });
        await sql`
          INSERT INTO ivy_nudges_fired (workspace_id, client_id, kind)
          VALUES (${r.workspace_id}, ${r.client_id}, 'awaiting_reply')
          ON CONFLICT (workspace_id, client_id, kind) DO UPDATE SET fired_at = NOW()
        `;
        awaitingFired++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[ivy-nudges/awaiting] failed for', r.client_id, err.message);
      }
    }

    // ─── 2. Gone quiet ──────────────────────────────────────────────
    // Client who had activity in the last ACTIVE_WINDOW_DAYS but
    // nothing in the last NUDGE_QUIET_DAYS. Activity = any booking,
    // sent message, invoice, or document update with this client.
    // Excludes clients in cooldown for this kind, and excludes
    // archived/lead-only contacts.
    const quiet = await sql`
      WITH activity AS (
        SELECT b.workspace_id, b.client_id,
               MAX((b.date::timestamptz) + (b.start_min || ' minutes')::interval) AS last_at
          FROM bookings b
         WHERE b.client_id IS NOT NULL
           AND b.date > (NOW() - (${ACTIVE_WINDOW_DAYS} || ' days')::interval)::date
         GROUP BY b.workspace_id, b.client_id
        UNION ALL
        SELECT t.workspace_id, t.client_id, MAX(t.last_message_at) AS last_at
          FROM message_threads t
         WHERE t.last_message_at > NOW() - (${ACTIVE_WINDOW_DAYS} || ' days')::interval
         GROUP BY t.workspace_id, t.client_id
        UNION ALL
        SELECT i.workspace_id, i.client_id, MAX(i.sent_at) AS last_at
          FROM invoices i
         WHERE i.client_id IS NOT NULL
           AND i.sent_at > NOW() - (${ACTIVE_WINDOW_DAYS} || ' days')::interval
         GROUP BY i.workspace_id, i.client_id
      ),
      latest AS (
        SELECT workspace_id, client_id, MAX(last_at) AS last_at
          FROM activity
         GROUP BY workspace_id, client_id
      )
      SELECT l.workspace_id, l.client_id, l.last_at, c.name AS client_name, c.stage
        FROM latest l
        JOIN clients c ON c.id = l.client_id AND c.workspace_id = l.workspace_id
        LEFT JOIN ivy_nudges_fired n
          ON n.workspace_id = l.workspace_id
         AND n.client_id    = l.client_id
         AND n.kind         = 'gone_quiet'
       WHERE l.last_at <= NOW() - (${NUDGE_QUIET_DAYS} || ' days')::interval
         AND l.last_at >  NOW() - (${ACTIVE_WINDOW_DAYS} || ' days')::interval
         AND n.workspace_id IS NULL
         AND c.stage = 'active'
       ORDER BY l.last_at ASC
       LIMIT ${MAX_PER_RUN}
    `;

    let quietFired = 0;
    for (const r of quiet.rows) {
      try {
        const draftPrompt = `Draft a casual check-in message for ${r.client_name || 'this client'}. They were active recently but I haven't heard from them in a while. Keep it warm, not salesy.`;
        notifyOwnerSafe({
          workspaceId: r.workspace_id, type: 'messages',
          payload: {
            title: 'Ivy · time to check in',
            body: `${r.client_name || 'A client'} has been quiet for ${daysBetween(r.last_at)} days. Tap to draft a check-in.`,
            url: `/ivy?prompt=${encodeURIComponent(draftPrompt)}`,
            tag: `ivy-quiet-${r.client_id}`,
          },
        });
        await sql`
          INSERT INTO ivy_nudges_fired (workspace_id, client_id, kind)
          VALUES (${r.workspace_id}, ${r.client_id}, 'gone_quiet')
          ON CONFLICT (workspace_id, client_id, kind) DO UPDATE SET fired_at = NOW()
        `;
        quietFired++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[ivy-nudges/quiet] failed for', r.client_id, err.message);
      }
    }

    return ok(res, {
      awaitingScanned: awaiting.rows.length,
      awaitingFired,
      quietScanned: quiet.rows.length,
      quietFired,
    });
  } catch (err) {
    return serverError(res, err);
  }
}

function daysBetween(iso) {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(1, Math.floor(ms / (1000 * 60 * 60 * 24)));
}
function humanAgo(iso) {
  if (!iso) return 'a while ago';
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default trackCron('ivy-nudges', handler);
