// /api/me/notification-prefs
//   GET   → return the user's notification flags (digest opt-in etc.)
//   PATCH → update one or more flags
//
// Used by /me/settings/notifications AND the owner Settings page.
//
// marketingEmails is the "Tips, product news and offers from Ivy" switch:
// the same consent as the optional sign-up box (users.marketing_consent_at,
// api/_lib/emailConsent.js). Turning it on records consent from
// 'settings'; turning it off withdraws it and also mutes the marketing
// email category, the same as the unsubscribe link does.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { readBody } from '../_lib/body.js';
import { readEmailConsent, setMarketingConsent } from '../_lib/emailConsent.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';

async function shape(userId, row) {
  const consent = await readEmailConsent(userId).catch(() => ({}));
  return {
    digestGroupsDaily: row.digest_groups_daily !== false,
    digestLastSentAt:  row.digest_last_sent_at || null,
    marketingEmails: !!consent.marketingEmails && (row.notification_prefs || {}).email_marketing !== false,
    marketingConsentAt: consent.marketingConsentAt || null,
    marketingConsentSource: consent.marketingConsentSource || null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && !requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const load = async () => (await sql`
      SELECT digest_groups_daily, digest_last_sent_at, notification_prefs FROM users WHERE id = ${user.id}
    `).rows[0] || {};
    if (req.method === 'GET') {
      return ok(res, { prefs: await shape(user.id, await load()) });
    }
    if (req.method === 'PATCH') {
      const body = (await readBody(req)) || {};
      const hasDigest = 'digestGroupsDaily' in body;
      const hasMarketing = 'marketingEmails' in body;
      if (hasMarketing && typeof body.marketingEmails !== 'boolean') {
        return badRequest(res, 'marketingEmails must be true or false');
      }
      if (hasDigest) {
        await sql`UPDATE users SET digest_groups_daily = ${!!body.digestGroupsDaily} WHERE id = ${user.id}`;
      }
      if (hasMarketing) {
        await setMarketingConsent(req, {
          userId: user.id, on: body.marketingEmails, source: 'settings', actor: user,
        });
        if (!body.marketingEmails) {
          await sql`
            UPDATE users
               SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || '{"email_marketing": false}'::jsonb
             WHERE id = ${user.id}
          `;
        }
      }
      return ok(res, { prefs: await shape(user.id, await load()) });
    }
    return methodNotAllowed(res, ['GET', 'PATCH']);
  } catch (err) {
    return serverError(res, err);
  }
}
