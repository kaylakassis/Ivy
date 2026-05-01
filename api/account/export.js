// GET /api/account/export — returns a JSON dump of every row tied to the
// authenticated user's account. Intended for the GDPR right-to-portability:
// users can download a complete copy of their data.
//
// Format: a single JSON object with one top-level key per table, plus the
// user record. Returned with Content-Disposition: attachment so browsers
// save it as a file rather than rendering inline.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
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

    const payload = {
      thryve_export_version: 1,
      exported_at: new Date().toISOString(),
      user:               profile.rows[0] || null,
      workspace:          workspace.rows[0] || null,
      website:            website.rows[0] || null,
      clients:            clients.rows,
      services:           services.rows,
      calendar_settings:  calendarSettings.rows[0] || null,
      calendar_blocks:    calendarBlocks.rows,
      bookings:           bookings.rows,
      message_threads:    messageThreads.rows,
      messages:           messages.rows,
      documents:          documents.rows,
      finance_settings:   financeSettings.rows[0] || null,
      invoices:           invoices.rows,
      tasks:              tasks.rows,
      goals:              goals.rows,
      reward_settings:    rewardSettings.rows[0] || null,
      reward_rules:       rewardRules.rows,
      reward_redemptions: rewardRedemptions.rows,
      ivy_sessions:       ivySessions.rows,
      ivy_messages:       ivyMessages.rows,
      ivy_usage:          ivyUsage.rows,
    };

    const filename = `thryve-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (err) {
    return serverError(res, err);
  }
}
