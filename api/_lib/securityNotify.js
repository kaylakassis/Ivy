// Security-alert emails: new-device sign-in, password change, 2FA on/off.
//
// These are CRITICAL sends (type 'security_alert' bypasses the recipient's
// email opt-out and the per-workspace quota) because they're about account
// safety - the kind of "was this you?" notice every serious app sends.
//
// All exports are best-effort: they catch internally and never throw, so a
// Resend hiccup can't break the auth flow they hang off of. Callers fire
// them without awaiting (same pattern as recordAudit).
import crypto from 'node:crypto';
import { sql } from './db.js';
import { sendEmailToUser, emailShell } from './email.js';
import { appUrl } from './tokens.js';
import { reportError } from './monitoring.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Best-effort, human-readable device label from a user-agent string.
function prettyDevice(ua = '') {
  const s = String(ua || '');
  if (!s) return 'an unknown device';
  if (/Capacitor|IvyOS/i.test(s)) return 'the Ivy OS app';
  let os = 'an unknown device';
  if (/iPhone|iPad|iPod|iOS/i.test(s)) os = 'iOS';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh/i.test(s)) os = 'macOS';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/CrOS/i.test(s)) os = 'ChromeOS';
  else if (/Linux/i.test(s)) os = 'Linux';
  let browser = '';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Chrome\//i.test(s) && !/Chromium/i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s) && !/Chrome/i.test(s)) browser = 'Safari';
  return browser ? `${browser} on ${os}` : os;
}

function fmtWhen() {
  return new Date().toLocaleString('en-US', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC',
  }) + ' UTC';
}

async function loadUser(userId) {
  try {
    const { rows } = await sql`SELECT email, name FROM users WHERE id = ${userId}`;
    return rows[0] || null;
  } catch { return null; }
}

// Shared sender for all three alert flavors.
async function sendSecurityAlert({ userId, subject, heading, intro, ip, userAgent }) {
  try {
    const u = await loadUser(userId);
    if (!u?.email) return;
    const device = prettyDevice(userAgent);
    const detail = `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px;font-size:13.5px;line-height:1.8;">
        <tr><td style="color:#8A8D85;padding-right:16px;vertical-align:top;">When</td><td style="color:#F3F3EE;">${escapeHtml(fmtWhen())}</td></tr>
        <tr><td style="color:#8A8D85;padding-right:16px;vertical-align:top;">Device</td><td style="color:#F3F3EE;">${escapeHtml(device)}</td></tr>
        ${ip ? `<tr><td style="color:#8A8D85;padding-right:16px;vertical-align:top;">IP address</td><td style="color:#F3F3EE;">${escapeHtml(ip)}</td></tr>` : ''}
      </table>`;
    const html = emailShell({
      heading,
      body: `<p>Hi ${escapeHtml((u.name || '').split(/\s+/)[0] || 'there')},</p>
        <p>${intro}</p>
        ${detail}
        <p style="margin-top:18px;">If this was you, you're all set - no action needed.</p>
        <p><strong>If this wasn't you</strong>, secure your account now: change your password and review your security settings.</p>`,
      ctaText: 'Review account security',
      ctaUrl: `${appUrl()}/account?tab=security`,
      footer: `You're getting this because it affects your account's security. For your protection, these alerts can't be turned off.`,
    });
    await sendEmailToUser({ userId, type: 'security_alert', to: u.email, subject, html, timeoutMs: 6000 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[securityNotify] send failed:', err.message);
    reportError(err, { extra: { userId } });
  }
}

export async function notifyPasswordChanged({ userId, ip, userAgent } = {}) {
  return sendSecurityAlert({
    userId, ip, userAgent,
    subject: 'Your Ivy OS password was changed',
    heading: 'Your password was changed',
    intro: 'The password on your Ivy OS account was just changed.',
  });
}

export async function notifyTwoFactorChanged({ userId, enabled, ip, userAgent } = {}) {
  return sendSecurityAlert({
    userId, ip, userAgent,
    subject: enabled
      ? 'Two-factor authentication was turned on'
      : 'Two-factor authentication was turned off',
    heading: enabled
      ? 'Two-factor authentication is on'
      : 'Two-factor authentication was turned off',
    intro: enabled
      ? 'Two-factor authentication (2FA) was just enabled on your Ivy OS account - nice, your account is now harder to break into.'
      : 'Two-factor authentication (2FA) was just turned off on your Ivy OS account. It is now protected by your password alone.',
  });
}

// New-device sign-in. Tracks a per-user set of device fingerprints (a hash
// of the user agent) and only alerts on a sign-in from a fingerprint we
// haven't recorded. The FIRST tracked sign-in for a user just seeds the
// baseline silently, so neither brand-new signups nor the rollout itself
// trigger an alert storm. Best-effort; callers fire-and-forget.
export async function maybeNotifyNewSignIn({ userId, ip, userAgent } = {}) {
  try {
    if (!userId) return;
    const fp = crypto.createHash('sha256').update(String(userAgent || 'unknown')).digest('hex').slice(0, 32);
    const { rows } = await sql`SELECT known_login_fingerprints FROM users WHERE id = ${userId}`;
    const raw = rows[0]?.known_login_fingerprints;
    const list = Array.isArray(raw) ? raw : [];
    if (list.includes(fp)) return; // recognized device

    const isBaseline = list.length === 0;
    const next = [...list, fp].slice(-20); // keep the 20 most recent
    await sql`UPDATE users SET known_login_fingerprints = ${JSON.stringify(next)}::jsonb WHERE id = ${userId}`;
    if (isBaseline) return; // first device on record → establish silently

    await sendSecurityAlert({
      userId, ip, userAgent,
      subject: 'New sign-in to your Ivy OS account',
      heading: 'New sign-in to your account',
      intro: "We noticed a sign-in to your Ivy OS account from a device or browser we haven't seen before.",
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[securityNotify/newSignIn] failed:', err.message);
    reportError(err, { extra: { userId } });
  }
}
