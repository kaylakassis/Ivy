// POST /api/admin/push-test  { userId?: string }
// Fires a test web-push notification, by default to the calling
// super-admin's own subscriptions. Pass `userId` to target a specific
// user instead - useful for verifying a customer's device is enrolled,
// or showing them what a real Ivy nudge looks like in support.
//
// Returns:
//   {
//     sent,        // count delivered to a push provider
//     removed,     // count of dead subscriptions cleaned up
//     target: {    // who the test was sent to
//       userId, email, name, isSelf,
//     },
//     devices: [   // every push_subscriptions row for this user
//       { id, userAgent, label, lastUsedAt },
//     ],
//   }
//
// `target` is echoed back so the UI can confirm "sent to alice@…"
// after the action - no possibility of silently hitting the wrong user.
// `devices` lets the admin see at-a-glance which browser / OS / phone
// the test reached.
//
// Audit log includes `targetUserId` whenever it differs from the actor,
// so cross-user sends are traceable.
import { sql } from '../_lib/db.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { requireSuperAdmin, getAdminActor } from '../_lib/admin.js';
import { recordAudit } from '../_lib/audit.js';
import { sendPushToUser } from '../_lib/push.js';
import { badRequest, methodNotAllowed, notFound, ok, serverError } from '../_lib/json.js';

// Tiny user-agent classifier - good enough to label a device
// at-a-glance ("Chrome on macOS", "Safari on iOS"). Falls back
// to the raw UA when nothing matches.
function labelForUserAgent(ua) {
  if (!ua) return 'Unknown device';
  const u = String(ua);
  let os = 'Unknown OS';
  if (/iPhone|iPad|iPod/i.test(u))        os = 'iOS';
  else if (/Android/i.test(u))            os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(u)) os = 'macOS';
  else if (/Windows/i.test(u))            os = 'Windows';
  else if (/Linux/i.test(u))              os = 'Linux';
  let browser = 'Browser';
  if (/Edg\//i.test(u))                    browser = 'Edge';
  else if (/Chrome\//i.test(u))            browser = 'Chrome';
  else if (/Firefox\//i.test(u))           browser = 'Firefox';
  else if (/Safari\//i.test(u))            browser = 'Safari';
  return `${browser} on ${os}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  if (!(await requireSuperAdmin(req, res))) return;

  try {
    const actor = await getAdminActor(req);
    if (!actor?.id) return serverError(res, new Error('Could not resolve admin user'));

    const body = await readBody(req).catch(() => ({}));
    const targetParam = (body?.userId || '').toString().trim();

    let targetUserId = actor.id;
    let target = { userId: actor.id, email: actor.email, name: actor.name, isSelf: true };
    if (targetParam && targetParam !== actor.id) {
      const { rows } = await sql`
        SELECT id, email, name FROM users WHERE id = ${targetParam} LIMIT 1
      `;
      if (rows.length === 0) return notFound(res, 'User not found');
      targetUserId = rows[0].id;
      target = { userId: rows[0].id, email: rows[0].email, name: rows[0].name, isSelf: false };
    }

    await recordAudit(req, {
      actor,
      action: 'admin.push_test',
      meta: target.isSelf ? {} : { targetUserId, targetEmail: target.email },
    });

    // Snapshot the target's device list BEFORE the send so the
    // response can show "we tried these N devices." sendPushToUser
    // updates last_used_at on success and DELETEs dead subscriptions,
    // so we capture user_agent here while it's still around.
    const { rows: subs } = await sql`
      SELECT id, user_agent, last_used_at
        FROM push_subscriptions
       WHERE user_id = ${targetUserId}
       ORDER BY last_used_at DESC NULLS LAST
    `;
    const devices = subs.map((s) => ({
      id:         s.id,
      userAgent:  s.user_agent || null,
      label:      labelForUserAgent(s.user_agent),
      lastUsedAt: s.last_used_at,
    }));

    // Mirrors an Ivy nudge payload so the preview is realistic. No
    // `type` passed → bypasses the user notification-pref gate (per
    // push.js: admin-side sends are intentionally unconditional).
    const payload = target.isSelf
      ? {
          title: 'Ivy · test notification',
          body:  'If you can read this, push notifications are working on this device.',
          url:   '/admin?tab=settings',
          tag:   'admin-push-test',
        }
      : {
          title: 'Ivy · test from your admin',
          body:  'This is a test notification sent by your Ivy administrator.',
          url:   '/',
          tag:   'admin-push-test',
        };

    const result = await sendPushToUser({ userId: targetUserId, payload });
    return ok(res, { ...result, target, devices });
  } catch (err) {
    return serverError(res, err);
  }
}
