// GET /api/account/export — returns a JSON dump of every row tied to the
// authenticated user's account. Intended for the GDPR right-to-portability:
// users can download a complete copy of their data.
//
// Format: a single JSON object with one top-level key per table, plus the
// user record. Returned with Content-Disposition: attachment so browsers
// save it as a file rather than rendering inline.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { myClientIds } from '../_lib/clientPortal.js';
import { requireSameOrigin } from '../_lib/security.js';
import { methodNotAllowed, serverError } from '../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;

  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    // Pull each workspace-scoped table. We intentionally read everything in
    // parallel rather than streaming — typical workspaces are small enough
    // (<10MB) that the overhead is fine; if export sizes ever blow up we
    // can switch to NDJSON.
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

    // Strip every encrypted-credential blob and OAuth refresh-token from
    // the export. These columns hold workspace credentials (Stripe secret
    // key, Square OAuth, Google refresh token, etc.) — even encrypted,
    // they should never leave the server in a user-facing download.
    // The ENCRYPTION_KEY rotates independently; pairing an exported blob
    // with a leaked key reproduces live credentials.
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
    const stripSensitive = (row) => {
      if (!row || typeof row !== 'object') return row;
      const out = { ...row };
      for (const k of SENSITIVE_KEYS) delete out[k];
      return out;
    };
    const stripRows = (rows) => Array.isArray(rows) ? rows.map(stripSensitive) : rows;

    // Client-side records: rows where THIS user is a CUSTOMER of other
    // businesses (their portal data). Without this a client-only user —
    // who never owns a real workspace — would download an export with
    // none of their actual data (bookings/invoices/documents/messages
    // they hold as a client elsewhere). Covers the portability promise.
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

    const payload = {
      thryve_export_version: 1,
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

    const filename = `thryve-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    // Stream the response in chunks rather than JSON.stringify-ing
    // the full payload to a single buffer. At scale (10K+ bookings,
    // 100K+ messages, etc.) the full buffer crosses 50MB and the
    // function OOMs. Chunked write keeps memory bounded: we render
    // the wrapping object scaffold + one section at a time. Result
    // is still a single valid JSON document.
    //
    // Per-section we still JSON.stringify each row's array in one
    // go because each table here tops out at <100K rows in any
    // realistic workspace and the marginal benefit of per-row
    // streaming isn't worth the code complexity.
    res.status(200);
    res.write('{\n');
    res.write(`  "thryve_export_version": 1,\n`);
    res.write(`  "exported_at": ${JSON.stringify(payload.exported_at)},\n`);
    const keys = Object.keys(payload).filter((k) => k !== 'thryve_export_version' && k !== 'exported_at');
    keys.forEach((k, i) => {
      res.write(`  ${JSON.stringify(k)}: ${JSON.stringify(payload[k], null, 2)}`);
      res.write(i === keys.length - 1 ? '\n' : ',\n');
    });
    res.write('}\n');
    return res.end();
  } catch (err) {
    return serverError(res, err);
  }
}
