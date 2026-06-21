// Notification preferences - shared layer for push + email.
//
// Two kinds of preferences live alongside each other:
//
//   • Push prefs (legacy, NOTIFY_TYPES in ./push.js):
//       messages, bookings, documents, payments, support
//     Stored on users.notification_prefs as bare keys.
//
//   • Email prefs (EMAIL_NOTIFY_TYPES below):
//       bookings, invoices, documents, messages, marketing, billing
//     Stored on users.notification_prefs prefixed with `email_`, AND on
//     clients.notification_prefs as bare keys (clients are workspace-
//     scoped so each client row holds prefs for that one workspace).
//
// Missing key = enabled by default. Failure to look up = enabled (don't
// drop a notification because of a transient DB blip).
//
// CRITICAL_EMAIL_TYPES bypass preferences entirely - these are sends
// the recipient can't opt out of because they're security- or
// account-critical (verification, password reset, account deletion).
import { sql } from './db.js';

export const EMAIL_NOTIFY_TYPES = [
  'bookings',    // confirmation, reminder, cancellation, reschedule
  'invoices',    // sent, paid, overdue, recurring
  'documents',   // sent, completed, declined, overdue
  'messages',    // new message from owner / client reply
  'marketing',   // review prompts, announcements, gift-card receipts
  'billing',     // owner-only: subscription renewal, failure, cancellation
];

// Labels shown in the notification settings UI. Keep terse - the
// per-type help text lives in the UI alongside.
export const EMAIL_NOTIFY_LABELS = {
  bookings:  'Bookings',
  invoices:  'Invoices',
  documents: 'Documents',
  messages:  'Messages',
  marketing: 'Reviews & announcements',
  billing:   'Subscription billing',
};

// Critical sends bypass preferences. These are tied to account
// security / identity - disabling them would break the product.
export const CRITICAL_EMAIL_TYPES = new Set([
  'verification',     // signup confirm, email change
  'password_reset',
  'account_deletion',
  'security_alert',   // new-device sign-in, password change, 2FA on/off
]);

// Read users.notification_prefs, return true if the `email_<type>` key
// is not explicitly false. Critical types always return true.
export async function userAllowsEmail(userId, type) {
  if (!type) return true;
  if (CRITICAL_EMAIL_TYPES.has(type)) return true;
  if (!EMAIL_NOTIFY_TYPES.includes(type)) return true;
  if (!userId) return true;
  try {
    const { rows } = await sql`SELECT notification_prefs FROM users WHERE id = ${userId}`;
    const prefs = rows[0]?.notification_prefs || {};
    return prefs[`email_${type}`] !== false;
  } catch {
    return true;
  }
}

// Read clients.notification_prefs. Critical types always return true.
// `clientId` is the clients.id (workspace-scoped), so the pref lookup
// is naturally workspace-isolated.
export async function clientAllowsEmail(clientId, type) {
  if (!type) return true;
  if (CRITICAL_EMAIL_TYPES.has(type)) return true;
  if (!EMAIL_NOTIFY_TYPES.includes(type)) return true;
  if (!clientId) return true;
  try {
    const { rows } = await sql`SELECT notification_prefs FROM clients WHERE id = ${clientId}`;
    const prefs = rows[0]?.notification_prefs || {};
    return prefs[type] !== false;
  } catch {
    return true;
  }
}

// Look up a client by email + workspace and return whether they allow
// emails of `type`. Used by send-sites that have an email address but
// no clients.id (e.g. the public booking flow keeps an email column
// even when no clients row exists). Workspace scoping is essential -
// a client of business A who opted out of marketing shouldn't suppress
// business B's marketing.
export async function clientAllowsEmailByAddress({ email, workspaceId, type }) {
  if (!type) return true;
  if (CRITICAL_EMAIL_TYPES.has(type)) return true;
  if (!email || !workspaceId) return true;
  try {
    const { rows } = await sql`
      SELECT notification_prefs FROM clients
       WHERE workspace_id = ${workspaceId}
         AND LOWER(email) = LOWER(${email})
       LIMIT 1
    `;
    if (rows.length === 0) return true; // no record = no prefs to check
    const prefs = rows[0]?.notification_prefs || {};
    return prefs[type] !== false;
  } catch {
    return true;
  }
}

// Default UI shape for the GET endpoint: every type resolved to true|false.
export function defaultEmailPrefs(stored = {}) {
  const out = {};
  for (const t of EMAIL_NOTIFY_TYPES) out[t] = stored[t] !== false;
  return out;
}
export function defaultEmailPrefsForUser(stored = {}) {
  const out = {};
  for (const t of EMAIL_NOTIFY_TYPES) out[t] = stored[`email_${t}`] !== false;
  return out;
}
