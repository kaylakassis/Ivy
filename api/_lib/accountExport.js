// Builds the full account-data export payload (GDPR right-to-portability).
// Shared by api/account/export.js (streamed download) and the emailed-copy
// path so the two never drift. Returns a single JSON-serializable object
// with one key per table, with all encrypted-credential / token columns
// stripped.
import { sql } from './db.js';
import { ensureWorkspace } from './auth.js';
import { myClientIds } from './clientPortal.js';

// Encrypted-credential blobs and token hashes that must never leave the
// server in a user-facing export, even encrypted (a leaked key + blob
// reproduces live credentials).
const SENSITIVE_KEYS = [
  'stripe_secret_encrypted',
  'stripe_webhook_secret_encrypted',
  'stripe_publishable_key',
  'square_credentials_encrypted',
  'paypal_credentials_encrypted',
  'google_refresh_token_encrypted',
  'twilio_auth_token_encrypted',
  'sms_twilio_auth_token_encrypted',
  'ical_feed_token_hash',
  'review_request_token_hash',
  'invoice_view_token_hash',
  'quote_view_token_hash',
  'sign_token_hash',
  'password_hash',
];

function stripSensitive(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const k of SENSITIVE_KEYS) delete out[k];
  return out;
}
const stripRows = (rows) => (Array.isArray(rows) ? rows.map(stripSensitive) : rows);

export async function buildAccountExport(user) {
  const workspaceId = await ensureWorkspace(user.id);

  const [
    profile, workspace, clients, services, calendarSettings, calendarBlocks,
    bookings, messageThreads, messages, documents,
    financeSettings, invoices, tasks, goals,
    rewardSettings, rewardRules, rewardRedemptions,
    ivySessions, ivyMessages, ivyUsage, website,
  ] = await Promise.all([
    sql`SELECT id, email, name, created_at, updated_at, email_verified_at
        FROM users WHERE id = ${user.id}`,
    sql`SELECT * FROM workspaces WHERE id = ${workspaceId}`,
    sql`SELECT * FROM clients          WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM services         WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM calendar_settings WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM calendar_blocks  WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM bookings         WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM message_threads  WHERE workspace_id = ${workspaceId}`,
    sql`SELECT m.* FROM messages m
        JOIN message_threads t ON t.id = m.thread_id
        WHERE t.workspace_id = ${workspaceId}`,
    sql`SELECT * FROM documents        WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM finance_settings WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM invoices         WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM tasks            WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM goals            WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM reward_settings  WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM reward_rules     WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM reward_redemptions WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM ivy_sessions     WHERE workspace_id = ${workspaceId}`,
    sql`SELECT m.* FROM ivy_messages m
        JOIN ivy_sessions s ON s.id = m.session_id
        WHERE s.workspace_id = ${workspaceId}`,
    sql`SELECT * FROM ivy_usage        WHERE workspace_id = ${workspaceId}`,
    sql`SELECT * FROM websites         WHERE workspace_id = ${workspaceId}`,
  ]);

  // Records where THIS user is a CUSTOMER of other businesses (their portal
  // data) - so a client-only user still gets a complete export.
  const myClients = await myClientIds(user).catch(() => []);
  const myIds = myClients.map((c) => c.clientId);
  let clientPortal = null;
  if (myIds.length) {
    const [cpBookings, cpInvoices, cpDocs, cpThreads, cpMessages] = await Promise.all([
      sql`SELECT * FROM bookings   WHERE client_id = ANY(${myIds})`,
      sql`SELECT * FROM invoices   WHERE client_id = ANY(${myIds})`,
      sql`SELECT * FROM documents  WHERE recipient_client_id = ANY(${myIds})`,
      sql`SELECT * FROM message_threads WHERE client_id = ANY(${myIds})`,
      sql`SELECT m.* FROM messages m
            JOIN message_threads t ON t.id = m.thread_id
           WHERE t.client_id = ANY(${myIds})`,
    ]);
    clientPortal = {
      businesses:      myClients,
      bookings:        stripRows(cpBookings.rows),
      invoices:        stripRows(cpInvoices.rows),
      documents:       stripRows(cpDocs.rows),
      message_threads: stripRows(cpThreads.rows),
      messages:        stripRows(cpMessages.rows),
    };
  }

  return {
    ivy_export_version: 1,
    exported_at: new Date().toISOString(),
    user:               stripSensitive(profile.rows[0] || null),
    workspace:          stripSensitive(workspace.rows[0] || null),
    website:            stripSensitive(website.rows[0] || null),
    clients:            stripRows(clients.rows),
    services:           stripRows(services.rows),
    calendar_settings:  stripSensitive(calendarSettings.rows[0] || null),
    calendar_blocks:    stripRows(calendarBlocks.rows),
    bookings:           stripRows(bookings.rows),
    message_threads:    stripRows(messageThreads.rows),
    messages:           stripRows(messages.rows),
    documents:          stripRows(documents.rows),
    finance_settings:   stripSensitive(financeSettings.rows[0] || null),
    invoices:           stripRows(invoices.rows),
    tasks:              stripRows(tasks.rows),
    goals:              stripRows(goals.rows),
    reward_settings:    stripSensitive(rewardSettings.rows[0] || null),
    reward_rules:       stripRows(rewardRules.rows),
    reward_redemptions: stripRows(rewardRedemptions.rows),
    ivy_sessions:       stripRows(ivySessions.rows),
    ivy_messages:       stripRows(ivyMessages.rows),
    ivy_usage:          stripRows(ivyUsage.rows),
    client_portal:      clientPortal,
  };
}

export function exportFilename() {
  return `ivy-export-${new Date().toISOString().slice(0, 10)}.json`;
}
