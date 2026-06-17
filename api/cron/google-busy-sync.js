// /api/cron/google-busy-sync — runs hourly (see vercel.json).
// Pulls personal-calendar busy windows from every workspace that has
// Google sync connected AND google_block_inbound enabled, mirroring
// them into external_busy_blocks. The slot conflict check on the
// public booking page consults those rows so a personal Google event
// blocks the Ivy OS slot automatically.
//
// Failures on individual workspaces are logged and stored on
// google_inbound_last_error so the owner sees them in the SyncDrawer
// — one workspace's bad token never breaks sync for everyone else.
import { sql } from '../_lib/db.js';
import { pullBusyTimes } from '../_lib/googleSync.js';
import { methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';

async function handler(req, res) {
  // Vercel crons fire as GET. Allow POST too for manual triggers.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }
  // Vercel cron requests carry an Authorization: Bearer <CRON_SECRET>
  // header. Refuse to run when the secret is unset — leaving the route
  // open made sense in early-stage deploys but production must always
  // require auth, otherwise anyone can trigger a sync of every
  // workspace's Google calendar on demand.
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== expected) return res.status(401).json({ error: 'Unauthorized' });

  try {
    await ensureSchemaApplied();
    const { rows } = await sql`
      SELECT workspace_id FROM calendar_settings
      WHERE google_refresh_token_encrypted IS NOT NULL
        AND google_block_inbound = TRUE
    `;

    const results = [];
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      const out = await pullBusyTimes({ workspaceId: r.workspace_id });
      if (!out.ok) {
        // eslint-disable-next-line no-await-in-loop
        await sql`
          UPDATE calendar_settings SET google_inbound_last_error = ${out.reason}
          WHERE workspace_id = ${r.workspace_id}
        `;
      }
      results.push({ workspaceId: r.workspace_id, ...out });
    }
    return ok(res, { ran: rows.length, results });
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('google-busy-sync', handler);
