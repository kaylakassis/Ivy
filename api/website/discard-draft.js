// POST /api/website/discard-draft - throw away every draft edit made since
// the last publish. The draft columns are restored from the published_*
// snapshot that api/website/publish.js (and the scheduled-publish cron and
// Ivy's publish tool) write. The live site reads only the published_*
// columns, so it is not touched.
//
// Draft-gated columns today: sections and pages. Everything else on the row
// (template, fonts, custom CSS, SEO, popups...) goes live as soon as it is
// saved, so there is no separate published copy of it to go back to.
//
// The editor makes the discard undoable on its side (it keeps the pre-discard
// draft in its undo history and PUTs it back on undo).
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { enforce } from '../_lib/rate-limit.js';
import { badRequest, methodNotAllowed, ok, serverError } from '../_lib/json.js';
import { serializeWebsite } from '../_lib/websiteSerialize.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    if (await enforce(req, res, [{ key: `website-discard:ws:${workspaceId}`, max: 60, windowSeconds: 3600 }])) return;

    const found = await sql`SELECT published_at FROM websites WHERE workspace_id = ${workspaceId}`;
    if (found.rows.length === 0 || !found.rows[0].published_at) {
      return badRequest(res, 'Your site has not been published yet, so there is no published version to go back to.');
    }

    // Copy every published_* column back onto its draft column. A NULL
    // published_* (sites published before the draft split) means the live
    // site already shows the draft, so the draft is kept as is.
    const updated = await sql`
      UPDATE websites SET
        sections   = COALESCE(published_sections, sections),
        pages      = COALESCE(published_pages, pages),
        updated_at = NOW()
      WHERE workspace_id = ${workspaceId}
        AND published_at IS NOT NULL
      RETURNING *
    `;
    if (updated.rows.length === 0) {
      return badRequest(res, 'Your site has not been published yet, so there is no published version to go back to.');
    }
    return ok(res, { discarded: true, website: serializeWebsite(updated.rows[0]) });
  } catch (err) {
    return serverError(res, err);
  }
}
