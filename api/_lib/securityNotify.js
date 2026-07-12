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
  if (/Capacitor|IvyOS/i.test(s)) return 'the Ivy app';
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

// Pure renderer for the security-alert family. Takes everything the
// notify functions normally compute (name, device, IP, when, kind) and
// returns the wire-shape { subject, html, preheader }. Used by both the
// real notify path AND the admin preview endpoint, so the preview an
// operator sees is byte-for-byte what real users get.
export function renderSecurityAlert({ kind, firstName: fnRaw, device, ip, when, enabled, supportEmail }) {
  const fn = escapeHtml(fnRaw || 'there');
  const supportAddr = supportEmail || process.env.EMAIL_REPLY_TO || 'hello@getivyos.com';

  let subject, preheader, heading, intro, decided;
  if (kind === 'new_signin') {
    subject = 'New sign-in to your Ivy account';
    preheader = 'Was this you?';
    heading = 'New sign-in to your account';
    intro = `Your Ivy account was just signed into:`;
    decided = `<p><strong>If this was you, you're all set</strong> — no action needed.</p>
      <p>If you don't recognize this, secure your account right away by changing your password.</p>`;
  } else if (kind === 'password_changed') {
    subject = 'Your Ivy password was changed';
    preheader = `If this wasn't you, act now.`;
    heading = 'Your password was changed';
    intro = `The password for your Ivy account was just changed:`;
    decided = `<p><strong>If you made this change</strong>, no action is needed.</p>
      <p><strong>If you didn't</strong>, your account may be at risk. Reset your password immediately and contact us at <a href="mailto:${escapeHtml(supportAddr)}" style="color:#CFFF50;text-decoration:underline;">${escapeHtml(supportAddr)}</a>.</p>`;
  } else if (kind === 'two_factor') {
    subject = enabled ? 'Two-factor authentication is on' : 'Two-factor authentication was turned off';
    preheader = enabled ? 'Your Ivy account just got more secure.' : 'Your account is now protected by your password alone.';
    heading = enabled ? 'Two-factor authentication is on' : 'Two-factor authentication was turned off';
    intro = enabled
      ? `Two-factor authentication was turned on for your Ivy account. From now on, you'll confirm a code when you sign in — nice work locking things down.`
      : `Two-factor authentication was turned off for your Ivy account. It is now protected by your password alone.`;
    decided = `<p>If you didn't make this change, secure your account right away.</p>`;
  } else {
    return null;
  }

  const detail = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px;font-size:13.5px;line-height:1.8;">
      <tr><td style="color:#8A8D85;padding-right:16px;vertical-align:top;">Device</td><td style="color:#F3F3EE;">${escapeHtml(device || 'an unknown device')}</td></tr>
      <tr><td style="color:#8A8D85;padding-right:16px;vertical-align:top;">Time</td><td style="color:#F3F3EE;">${escapeHtml(when || fmtWhen())}</td></tr>
      ${ip ? `<tr><td style="color:#8A8D85;padding-right:16px;vertical-align:top;">IP</td><td style="color:#F3F3EE;">${escapeHtml(ip)}</td></tr>` : ''}
    </table>`;

  const html = emailShell({
    heading, preheader,
    body: `<p>Hi ${fn},</p>
      <p>${intro}</p>
      ${detail}
      ${decided}`,
    ctaText: kind === 'password_changed' ? 'Reset my password' : 'Review account security',
    ctaUrl: kind === 'password_changed' ? `${appUrl()}/forgot-password` : `${appUrl()}/account?tab=security`,
    footer: `You're getting this because it affects your account's security. For your protection, these alerts can't be turned off. — The Ivy Team`,
  });
  return { subject, html, preheader };
}

async function sendSecurityAlert({ userId, kind, ip, userAgent, enabled }) {
  try {
    const u = await loadUser(userId);
    if (!u?.email) return;
    const rendered = renderSecurityAlert({
      kind,
      firstName: (u.name || '').split(/\s+/)[0],
      device: prettyDevice(userAgent),
      when: fmtWhen(),
      ip,
      enabled,
    });
    if (!rendered) return;
    await sendEmailToUser({
      userId, type: 'security_alert',
      to: u.email,
      subject: rendered.subject, html: rendered.html,
      timeoutMs: 6000,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[securityNotify] send failed:', err.message);
    reportError(err, { extra: { userId } });
  }
}

export async function notifyPasswordChanged({ userId, ip, userAgent } = {}) {
  return sendSecurityAlert({ userId, kind: 'password_changed', ip, userAgent });
}

export async function notifyTwoFactorChanged({ userId, enabled, ip, userAgent } = {}) {
  return sendSecurityAlert({ userId, kind: 'two_factor', ip, userAgent, enabled });
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

    await sendSecurityAlert({ userId, kind: 'new_signin', ip, userAgent });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[securityNotify/newSignIn] failed:', err.message);
    reportError(err, { extra: { userId } });
  }
}
