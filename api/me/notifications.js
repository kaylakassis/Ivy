// /api/me/notifications
//   GET   → current per-type prefs (push + email)
//   PATCH → update one or more keys. Body:
//     { pushPrefs?: { messages: false, ... }, emailPrefs?: { bookings: false, ... } }
//
// Both push and email prefs land on the same users.notification_prefs JSONB:
//   • Push keys are bare:           { messages: false }
//   • Email keys are `email_`-prefixed: { email_bookings: false }
//
// Critical email types (verification, password_reset, account_deletion)
// always send regardless of preferences.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { readBody } from '../_lib/body.js';
import { requireSameOrigin } from '../_lib/security.js';
import { NOTIFY_TYPES, LISTED_PUSH_TYPES } from '../_lib/push.js';
import { EMAIL_NOTIFY_TYPES, EMAIL_NOTIFY_LABELS, UNLISTED_EMAIL_TYPES } from '../_lib/notificationPrefs.js';

// The lists the app draws one row per type from. The accountability
// partner's switches are left out (the new app draws its own row with a
// turn-off warning); its keys are still in pushPrefs / emailPrefs and
// PATCH still accepts them.
const LISTED_EMAIL_TYPES = EMAIL_NOTIFY_TYPES.filter((t) => !UNLISTED_EMAIL_TYPES.includes(t));
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { setMarketingConsent } from '../_lib/emailConsent.js';

function resolve(stored) {
  const push = {};
  for (const t of NOTIFY_TYPES) push[t] = stored[t] !== false;
  const email = {};
  for (const t of EMAIL_NOTIFY_TYPES) email[t] = stored[`email_${t}`] !== false;
  return { push, email };
}

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      let stored = {};
      try {
        const r = await sql`SELECT notification_prefs FROM users WHERE id = ${user.id}`;
        stored = r.rows[0]?.notification_prefs || {};
      } catch (e) {
        // notification_prefs column missing - fall back to defaults so
        // the account page can still render notification settings.
        // eslint-disable-next-line no-console
        console.error('[me/notifications GET] failed (using defaults):', e.message);
      }
      const { push, email } = resolve(stored);
      return ok(res, {
        pushPrefs: push, emailPrefs: email,
        pushTypes: LISTED_PUSH_TYPES, emailTypes: LISTED_EMAIL_TYPES,
        emailLabels: EMAIL_NOTIFY_LABELS,
        // Back-compat for older clients that read `prefs` / `types`.
        prefs: push, types: LISTED_PUSH_TYPES,
      });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const incomingPush  = body && typeof body.pushPrefs  === 'object' ? body.pushPrefs  : null;
      const incomingEmail = body && typeof body.emailPrefs === 'object' ? body.emailPrefs : null;
      // Back-compat: old clients sent `prefs` and meant push.
      const legacy = body && typeof body.prefs === 'object' ? body.prefs : null;
      if (!incomingPush && !incomingEmail && !legacy) return badRequest(res, 'pushPrefs or emailPrefs is required');

      const r = await sql`SELECT notification_prefs FROM users WHERE id = ${user.id}`;
      const next = { ...(r.rows[0]?.notification_prefs || {}) };

      const pushSrc = incomingPush || legacy;
      if (pushSrc) {
        for (const t of NOTIFY_TYPES) {
          if (t in pushSrc) next[t] = !!pushSrc[t];
        }
      }
      if (incomingEmail) {
        for (const t of EMAIL_NOTIFY_TYPES) {
          if (t in incomingEmail) next[`email_${t}`] = !!incomingEmail[t];
        }
      }

      await sql`
        UPDATE users SET notification_prefs = ${JSON.stringify(next)}::jsonb
        WHERE id = ${user.id}
      `;
      // Muting the marketing category (an older app's "Reviews &
      // announcements" switch) also withdraws Ivy marketing consent.
      if (incomingEmail && 'marketing' in incomingEmail && !incomingEmail.marketing) {
        await setMarketingConsent(req, { userId: user.id, on: false, source: 'settings', actor: user });
      }
      const { push, email } = resolve(next);
      return ok(res, {
        pushPrefs: push, emailPrefs: email,
        pushTypes: LISTED_PUSH_TYPES, emailTypes: LISTED_EMAIL_TYPES,
        emailLabels: EMAIL_NOTIFY_LABELS,
        prefs: push, types: LISTED_PUSH_TYPES,
      });
    }

    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
