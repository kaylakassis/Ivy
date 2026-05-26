// SMS helper layer on top of _lib/twilio. Owns:
//   • Phone normalization to E.164 (+CCXXXXXXXXXX)
//   • Compliance suffix on every outbound ("Reply STOP to opt out") so
//     we don't drift out of TCPA / 10DLC requirements
//   • Consent gating — clients with sms_consent_at NULL never receive
//     a non-essential message, full stop. Booking-confirmation /
//     reminder paths must check consent before calling sendBookingSms.
//
// THRYVE pays for SMS as part of subscription so owners don't have to
// wire up Twilio themselves. Switching to per-workspace BYO Twilio is
// a future option — keep the API of this module shaped so callers
// only pass workspaceId + recipient details, no token plumbing.
import { sendSms, isTwilioConfigured } from './twilio.js';
import { tryConsumeQuota, DEFAULT_SMS_CAP_PER_DAY } from './usageCounters.js';
import { sql } from './db.js';

// TCPA + carrier best practice: avoid SMS outside 8am-9pm local time.
// Booking reminders are transactional (TCPA exempt) and should fire on
// schedule regardless — they pass respectQuietHours: false. Workflow
// SMS actions (marketing/nurture) pass true, gating them to daytime
// in the workspace's IANA timezone. If we have no timezone on file,
// fall back to America/New_York (most US workspaces today).
async function isInQuietHours(workspaceId) {
  if (!workspaceId) return false;
  let tz = 'America/New_York';
  try {
    const r = await sql`
      SELECT timezone FROM calendar_settings
       WHERE workspace_id = ${workspaceId} LIMIT 1
    `;
    if (r.rows[0]?.timezone) tz = r.rows[0].timezone;
  } catch {
    // calendar_settings missing on a brand-new workspace — accept the
    // default and continue. SMS sending is rare on day-zero so any
    // misalignment is short-lived.
  }
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hour12: false, timeZone: tz,
    });
    const hour = Number(fmt.format(new Date()));
    if (!Number.isFinite(hour)) return false;
    // 8:00 - 20:59 local is OK; 21:00 - 07:59 is quiet.
    return hour < 8 || hour >= 21;
  } catch {
    return false;
  }
}

// Normalize whatever the user typed to E.164. Strip non-digits, then:
//   • starts with '+' → assume already E.164, keep digits + plus
//   • 10 digits → assume +1 (US/Canada default) — works for the bulk
//                   of our market, can be made smarter per-workspace later
//   • 11 digits starting with 1 → +1XXXXXXXXXX
//   • otherwise return null (caller treats as invalid)
export function normalizePhone(raw, defaultCountry = '+1') {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const hadPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (hadPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    return '+' + digits;
  }
  if (digits.length === 10) return defaultCountry + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length >= 11 && digits.length <= 15) return '+' + digits;
  return null;
}

// Append the standard opt-out suffix exactly once. Idempotent —
// callers can naïvely add it without worrying about double-tagging.
export function withOptOutSuffix(body) {
  if (!body) return body;
  if (/reply\s+stop/i.test(body)) return body;
  return body.trim() + '\n\nReply STOP to opt out.';
}

// Send a message to a client, gated on (1) Twilio configured, (2) phone
// non-empty + normalized, (3) consent timestamp present, (4) workspace
// daily SMS quota not exceeded (§2.8). Returns { ok, reason?, sid? }.
//
// workspaceId is optional for legacy callers; without it, the daily
// cap is skipped. Every NEW caller should pass it so an abusive
// workspace cannot burn through THRYVE-paid Twilio credits in a
// single afternoon.
export async function sendClientSms({ phone, consentAt, body, workspaceId, respectQuietHours = false }) {
  if (!isTwilioConfigured()) return { ok: false, reason: 'twilio not configured' };
  if (!phone) return { ok: false, reason: 'no phone' };
  if (!consentAt) return { ok: false, reason: 'no consent' };

  const to = normalizePhone(phone);
  if (!to) return { ok: false, reason: 'invalid phone' };

  // Quiet hours: marketing-class SMS (workflow actions, broadcasts)
  // must not fire outside 8am-9pm local time. Transactional sends
  // (booking reminders, two-way replies) pass respectQuietHours=false
  // and bypass — TCPA exempts transactional/emergency.
  if (respectQuietHours && await isInQuietHours(workspaceId)) {
    return { ok: false, reason: 'quiet-hours' };
  }

  // Pre-charge the quota counter so two parallel sends can't both
  // pass the check. The counter increments first; if we're over the
  // cap, abort before contacting Twilio. (Slight downside: a Twilio
  // failure still counts against the quota for today — acceptable
  // for cost control.)
  if (workspaceId) {
    const q = await tryConsumeQuota(workspaceId, 'sms', DEFAULT_SMS_CAP_PER_DAY);
    if (!q.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[sms] workspace ${workspaceId} hit daily cap (${q.count}/${q.cap})`);
      return { ok: false, reason: 'workspace-quota-exceeded' };
    }
  }

  try {
    const r = await sendSms({ to, body: withOptOutSuffix(body) });
    return { ok: true, sid: r.sid, status: r.status };
  } catch (err) {
    return { ok: false, reason: err.message || 'send failed' };
  }
}
