// Email consent: the two sign-up checkboxes and the marketing switch.
//
//   • Account and service emails (required at sign-up): "I agree to receive
//     emails from Ivy about my account and the service". Stored as
//     users.account_email_consent_at. Older app builds (iPhone 1.0.4) do
//     not send the field at all: those sign-ups still go through, the
//     column stays NULL ("not recorded"), and account emails keep going
//     out because they are needed to run the account.
//   • Marketing (optional, unticked by default): "Send me tips, product
//     news and offers from Ivy". Stored as users.marketing_consent_at +
//     marketing_consent_source. NULL means not opted in (or withdrawn).
//     Changeable later in settings; unsubscribing from a marketing email
//     withdraws it.
//
// Proof: grants at sign-up are appended to legal_acceptances (same row
// shape as the Terms / Privacy acceptances, with IP + user agent); later
// changes are written to audit_events via recordAudit.
import { sql } from './db.js';
import { getClientIp } from './rate-limit.js';
import { recordAudit } from './audit.js';

// Bump when the wording of a checkbox changes, so the proof row says
// which sentence the person agreed to.
export const ACCOUNT_EMAILS_CONSENT_VERSION = '2026-11-05';
export const MARKETING_CONSENT_VERSION = '2026-11-05';

export const ACCOUNT_EMAILS_REQUIRED_MESSAGE =
  'Please agree to receive emails about your account and the service to create an account.';

const SOURCES = new Set(['signup', 'helper_invite', 'settings', 'unsubscribe', 'admin']);

// Reads the consent fields from a sign-up body.
//   acceptedAccountEmails: true      → consent given now
//   acceptedAccountEmails absent     → old app build, record nothing (null)
//   acceptedAccountEmails anything else (false, "yes", 1...) → refuse
//   marketingOptIn: true             → opted in; anything else → not
export function parseSignupConsent(body) {
  const b = body && typeof body === 'object' ? body : {};
  const has = Object.prototype.hasOwnProperty.call(b, 'acceptedAccountEmails')
    && b.acceptedAccountEmails !== undefined && b.acceptedAccountEmails !== null;
  if (has && b.acceptedAccountEmails !== true) return { refuse: true };
  return {
    refuse: false,
    accountEmails: has ? true : null,
    marketing: b.marketingOptIn === true,
  };
}

// Stamp the consent columns and append the proof rows for a brand-new
// account. Throws on a DB error so the caller's compensation (delete the
// half-made user) runs, the same as the Terms acceptance rows.
export async function recordSignupConsent(req, { userId, consent, source = 'signup' }) {
  if (!userId || !consent) return;
  const src = SOURCES.has(source) ? source : 'signup';
  await sql`
    UPDATE users
       SET account_email_consent_at = CASE WHEN ${consent.accountEmails === true} THEN NOW() ELSE account_email_consent_at END,
           marketing_consent_at     = CASE WHEN ${consent.marketing === true} THEN NOW() ELSE NULL END,
           marketing_consent_source = CASE WHEN ${consent.marketing === true} THEN ${src} ELSE NULL END
     WHERE id = ${userId}
  `;
  const ip = req ? getClientIp(req) : null;
  const ua = req?.headers?.['user-agent']?.toString().slice(0, 500) || null;
  if (consent.accountEmails === true) {
    await sql`
      INSERT INTO legal_acceptances (user_id, document, version, ip, user_agent)
      VALUES (${userId}, 'account_emails', ${ACCOUNT_EMAILS_CONSENT_VERSION}, ${ip}, ${ua})
    `;
  }
  if (consent.marketing === true) {
    await sql`
      INSERT INTO legal_acceptances (user_id, document, version, ip, user_agent)
      VALUES (${userId}, 'marketing_emails', ${MARKETING_CONSENT_VERSION}, ${ip}, ${ua})
    `;
  }
}

// Turn marketing consent on or off after sign-up. Idempotent: turning on
// when already on keeps the original date and source; turning off when
// already off changes nothing. Returns the resulting state.
// `actor` is who made the change (the person themself, or null for an
// unsubscribe link, which carries no session).
export async function setMarketingConsent(req, { userId, on, source, actor = null }) {
  if (!userId) return null;
  const src = SOURCES.has(source) ? source : 'settings';
  const before = (await sql`
    SELECT marketing_consent_at, notification_prefs, deleted_at FROM users WHERE id = ${userId}
  `).rows[0];
  if (!before) return null;
  const mutedCategory = (before.notification_prefs || {}).email_marketing === false;
  const already = on ? (!!before.marketing_consent_at && !mutedCategory) : !before.marketing_consent_at;
  if (already || (on && before.deleted_at)) return readEmailConsent(userId);
  if (on) {
    await sql`
      UPDATE users
         SET marketing_consent_at = COALESCE(marketing_consent_at, NOW()),
             marketing_consent_source = CASE WHEN marketing_consent_at IS NULL THEN ${src} ELSE marketing_consent_source END,
             -- Choosing marketing again lifts an earlier unsubscribe from
             -- the same category, or the switch would say on and nothing
             -- would ever arrive.
             notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) - 'email_marketing'
       WHERE id = ${userId} AND deleted_at IS NULL
    `;
  } else {
    await sql`
      UPDATE users
         SET marketing_consent_withdrawn_at = NOW(),
             marketing_consent_at = NULL,
             marketing_consent_source = NULL
       WHERE id = ${userId} AND marketing_consent_at IS NOT NULL
    `;
  }
  await recordAudit(req, {
    actor: actor || { id: userId },
    targetUserId: userId,
    action: on ? 'marketing_consent.grant' : 'marketing_consent.withdraw',
    meta: { source: src, version: MARKETING_CONSENT_VERSION },
  });
  return readEmailConsent(userId);
}

// Read-only view for settings pages.
export async function readEmailConsent(userId) {
  const { rows } = await sql`
    SELECT account_email_consent_at, marketing_consent_at, marketing_consent_source
      FROM users WHERE id = ${userId}
  `;
  const row = rows[0] || {};
  return {
    marketingEmails: !!row.marketing_consent_at,
    marketingConsentAt: row.marketing_consent_at ? new Date(row.marketing_consent_at).toISOString() : null,
    marketingConsentSource: row.marketing_consent_source || null,
    accountEmailsConsentAt: row.account_email_consent_at ? new Date(row.account_email_consent_at).toISOString() : null,
  };
}
