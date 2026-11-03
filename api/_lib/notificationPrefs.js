// Notification preferences - shared layer for push + email.
//
// Two kinds of preferences live alongside each other:
//
//   • Push prefs (legacy, NOTIFY_TYPES in ./push.js):
//       messages, bookings, documents, payments, support, engagement, client_optouts
//     Stored on users.notification_prefs as bare keys.
//
//   • Email prefs (EMAIL_NOTIFY_TYPES below):
//       bookings, invoices, documents, messages, marketing, billing, reports,
//       programs, client_optouts
//     Stored on users.notification_prefs prefixed with `email_`, AND on
//     clients.notification_prefs as bare keys (clients are workspace-
//     scoped so each client row holds prefs for that one workspace).
//
// Missing key = enabled by default. Failure to look up = enabled (don't
// drop a notification because of a transient DB blip).
//
// CRITICAL_EMAIL_TYPES bypass preferences entirely - these are sends
// the recipient can't opt out of because they're security- or
// account-critical (verification, password reset, account deletion),
// or a record the person must get (receipts, the invoice itself).
import { sql } from './db.js';

export const EMAIL_NOTIFY_TYPES = [
  'bookings',    // confirmation, reminder, cancellation, reschedule
  'invoices',    // quotes, due-soon and overdue reminders, payment problems
  'documents',   // sent, completed, declined, overdue
  'messages',    // new message from owner / client reply
  'marketing',   // review prompts, announcements, campaigns
  'billing',     // owner-only: subscription renewal, failure, cancellation
  'reports',     // owner-only: weekly recap of bookings, revenue, etc.
  'programs',    // client: new lessons and newly opened modules in their programs
  'client_optouts', // owner-only: a client unsubscribed from this business's emails
];

// Owner-only categories never go to clients, so the client portal does
// not offer a switch for them. 'programs' is the mirror image (client-only)
// and the owner Account page hides it.
export const OWNER_ONLY_EMAIL_TYPES = ['reports', 'client_optouts'];
export const CLIENT_EMAIL_TYPES = EMAIL_NOTIFY_TYPES.filter((t) => !OWNER_ONLY_EMAIL_TYPES.includes(t));

// Labels shown in the notification settings UI. Keep terse - the
// per-type help text lives in the UI alongside.
export const EMAIL_NOTIFY_LABELS = {
  bookings:  'Bookings',
  invoices:  'Invoices',
  documents: 'Documents',
  messages:  'Messages',
  marketing: 'Reviews & announcements',
  billing:   'Subscription billing',
  reports:   'Weekly business recap',
  programs:  'Programs',
  client_optouts: 'Client email opt-outs',
};

// Critical sends bypass preferences. These are tied to account
// security / identity - disabling them would break the product - or
// they are a record the recipient must get.
export const CRITICAL_EMAIL_TYPES = new Set([
  'verification',     // signup confirm, email change
  'password_reset',
  'account_deletion',
  'security_alert',   // new-device sign-in, password change, 2FA on/off
  'receipts',         // receipts, refunds and the invoice itself
]);

// Read users.notification_prefs, return true if the `email_<type>` key
// is not explicitly false. Critical types always return true - except for
// a deleted account, which gets nothing at all, critical or not.
export async function userAllowsEmail(userId, type) {
  if (!userId) return true;
  let row;
  try {
    const { rows } = await sql`SELECT notification_prefs, deleted_at FROM users WHERE id = ${userId}`;
    row = rows[0];
  } catch {
    return true;
  }
  if (row?.deleted_at) return false;
  if (!type) return true;
  if (CRITICAL_EMAIL_TYPES.has(type)) return true;
  if (!EMAIL_NOTIFY_TYPES.includes(type)) return true;
  const prefs = row?.notification_prefs || {};
  return prefs[`email_${type}`] !== false;
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// A client's email opt-out is per business and per ADDRESS, not per
// clients row: a business can hold the same person twice (an import plus
// a booking), and an unsubscribe must stop every send from that business
// to that address. A type is muted when any clients row in the workspace
// with that address has prefs[type] === false, OR an active opt-out in
// client_email_optouts covers that type (or 'all'). The second source is
// what makes an unsubscribe stick for an address that has no clients row
// yet (website newsletter sign-ups, public booking emails) and for a
// clients row created later. $1 workspace_id, $2 normalized email, $3 type.
const MUTED_FOR_ADDRESS = `
  (EXISTS (SELECT 1 FROM clients c2
            WHERE c2.workspace_id = $1 AND LOWER(c2.email) = $2
              AND c2.notification_prefs->>$3 = 'false')
   OR EXISTS (SELECT 1 FROM client_email_optouts o
               WHERE o.workspace_id = $1 AND o.email = $2
                 AND o.cleared_at IS NULL AND o.type IN ($3, 'all')))`;

async function mutedForAddress(workspaceId, email, type) {
  const r = await sql.query(`SELECT ${MUTED_FOR_ADDRESS} AS muted`, [workspaceId, email, type]);
  return !!r.rows[0]?.muted;
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
    const { rows } = await sql`SELECT workspace_id, email, notification_prefs FROM clients WHERE id = ${clientId}`;
    const row = rows[0];
    if (!row) return true;
    if ((row.notification_prefs || {})[type] === false) return false;
    const email = normalizeEmail(row.email);
    if (!email) return true;
    return !(await mutedForAddress(row.workspace_id, email, type));
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
  if (!EMAIL_NOTIFY_TYPES.includes(type)) return true;
  const addr = normalizeEmail(email);
  if (!addr || !workspaceId) return true;
  try {
    return !(await mutedForAddress(workspaceId, addr, type));
  } catch {
    return true;
  }
}

// Effective per-type prefs for one clients row, as the client portal
// shows them: a type reads OFF when it is muted for this business and
// address by any source above. Returns { [type]: boolean } over
// CLIENT_EMAIL_TYPES.
export async function effectiveClientEmailPrefs(clientId) {
  const out = {};
  for (const t of CLIENT_EMAIL_TYPES) out[t] = true;
  if (!clientId) return out;
  const { rows } = await sql`SELECT workspace_id, email, notification_prefs FROM clients WHERE id = ${clientId}`;
  const row = rows[0];
  if (!row) return out;
  const apply = (p) => { for (const t of CLIENT_EMAIL_TYPES) if ((p || {})[t] === false) out[t] = false; };
  apply(row.notification_prefs);
  const email = normalizeEmail(row.email);
  if (!email) return out;
  const sib = await sql`
    SELECT notification_prefs FROM clients
     WHERE workspace_id = ${row.workspace_id} AND LOWER(email) = ${email}`;
  for (const s of sib.rows) apply(s.notification_prefs);
  const log = await sql`
    SELECT DISTINCT type FROM client_email_optouts
     WHERE workspace_id = ${row.workspace_id} AND email = ${email} AND cleared_at IS NULL`;
  for (const l of log.rows) {
    if (l.type === 'all') for (const t of CLIENT_EMAIL_TYPES) out[t] = false;
    else if (l.type in out) out[l.type] = false;
  }
  return out;
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
