// The email that tells existing users the Terms of Service and Privacy
// Policy were updated.
//
// Both documents promise at least 14 days' notice of a material change, by
// email, in the app, or both. The in-app prompt only reaches people who
// open Ivy, so this email reaches the rest. It is sent from Admin by a
// person pressing a button, never by itself.
//
// Who gets it: every account with a verified email that has not already
// accepted the current versions and has not already been sent this notice.
// It is a notice about the agreement itself, so marketing choices do not
// apply and it carries no unsubscribe link (type 'legal_notice').
//
// At most once per person per version: each send first claims the person
// (users.legal_notice_version), and hands the claim back if the mail
// provider refuses, so pressing the button again only sends what is left.
//
// The wording does not describe what changed. People read that in the
// documents themselves.
import { sql } from './db.js';
import { sendEmailToUser, emailShell } from './email.js';
import { appUrl } from './tokens.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION, LEGAL_EFFECTIVE_LABEL } from './legal.js';

// One marker for the pair of documents as they stand now.
export function legalNoticeVersion() {
  return `terms:${CURRENT_TERMS_VERSION}|privacy:${CURRENT_PRIVACY_VERSION}`;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderLegalNotice({ firstName } = {}) {
  const base = appUrl();
  const fn = escapeHtml((firstName || '').trim() || 'there');
  const link = (path, label) => `<a href="${base}${path}" style="color:#2f7d5b;">${label}</a>`;
  const subject = 'We updated our Terms of Service and Privacy Policy';
  const preheader = `The updated versions take effect on ${LEGAL_EFFECTIVE_LABEL}.`;
  const body = `<p>Hi ${fn},</p>
      <p>We updated Ivy's ${link('/terms', 'Terms of Service')} and ${link('/privacy', 'Privacy Policy')}. The updated versions take effect on <strong>${LEGAL_EFFECTIVE_LABEL}</strong>.</p>
      <p>Please take a few minutes to read them. The next time you open Ivy you will be asked to accept them. Until ${LEGAL_EFFECTIVE_LABEL} you can choose to be reminded later.</p>
      <p>If you do not agree with the updated versions, you can stop using Ivy and close your account before they take effect. If you run a business on Ivy, you can also cancel your subscription and download your data first, from your Account page.</p>
      <p>Questions? Reply to this email or write to <a href="mailto:support@joinivy.ai" style="color:#2f7d5b;">support@joinivy.ai</a>.</p>`;
  const html = emailShell({
    heading: 'We updated our Terms of Service and Privacy Policy',
    preheader,
    body,
    ctaText: 'Read the Terms of Service →',
    ctaUrl: `${base}/terms`,
    footer: 'The Ivy Team',
  });
  // The same words as plain lines, for the preview in Admin.
  const lines = body.split('</p>').map((x) => x.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { subject, html, preheader, lines };

}

// Verified address, not deleted, not a flagged test account, has not
// accepted both current documents, and has not been sent this notice.
const WHO = `
      u.email IS NOT NULL
  AND u.email_verified_at IS NOT NULL
  AND u.deleted_at IS NULL
  AND NOT COALESCE(u.is_tester, FALSE)
  AND (u.terms_version IS DISTINCT FROM $1 OR u.privacy_version IS DISTINCT FROM $2)
  AND u.legal_notice_version IS DISTINCT FROM $3`;

export async function countLegalNoticeRecipients() {
  const { rows } = await sql.query(
    `SELECT COUNT(*)::int AS n FROM users u WHERE ${WHO}`,
    [CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION, legalNoticeVersion()],
  );
  return rows[0]?.n || 0;
}

export async function countLegalNoticeSent() {
  const { rows } = await sql`SELECT COUNT(*)::int AS n FROM users WHERE legal_notice_version = ${legalNoticeVersion()}`;
  return rows[0]?.n || 0;
}

// Sends to as many people as fit in `budgetMs`, then says how many are
// left. Never throws for one bad address.
export async function sendLegalNotices({ budgetMs = 40000, batch = 20 } = {}) {
  const version = legalNoticeVersion();
  const deadline = Date.now() + budgetMs;
  const failedIds = [];
  let sent = 0; let failed = 0;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await sql.query(
      `SELECT u.id, u.email, u.name FROM users u
        WHERE ${WHO} AND NOT (u.id = ANY($4::uuid[]))
        ORDER BY u.created_at ASC, u.id ASC LIMIT $5`,
      [CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION, version, failedIds, batch],
    );
    if (!rows.length) break;
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(rows.map(async (u) => {
      // Claim first, so two presses of the button (or two admins) can never
      // send the same person two emails.
      const claim = await sql`
        UPDATE users SET legal_notice_version = ${version}, legal_notice_sent_at = NOW()
         WHERE id = ${u.id} AND legal_notice_version IS DISTINCT FROM ${version}
        RETURNING id`;
      if (!claim.rows.length) return 'skipped';
      const mail = renderLegalNotice({ firstName: (u.name || '').split(/\s+/)[0] });
      const r = await sendEmailToUser({ userId: u.id, type: 'legal_notice', to: u.email, subject: mail.subject, html: mail.html })
        .catch((e) => ({ ok: false, reason: e?.message }));
      if (r?.sent) return 'sent';
      // Not accepted by the mail provider: hand the claim back for a later try.
      await sql`UPDATE users SET legal_notice_version = NULL, legal_notice_sent_at = NULL WHERE id = ${u.id} AND legal_notice_version = ${version}`.catch(() => {});
      failedIds.push(u.id);
      return 'failed';
    }));
    sent += results.filter((x) => x === 'sent').length;
    failed += results.filter((x) => x === 'failed').length;
  }
  const remaining = await countLegalNoticeRecipients();
  return { sent, failed, remaining };
}
