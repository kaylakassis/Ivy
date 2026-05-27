// POST /api/bug-reports   body: { title, body?, severity?, url?, viewport?, appVersion? }
//
// User-side "Report a bug" submission. Captures the description from
// the user plus context (URL they were on, browser, viewport, app
// version) so the super-admin can triage without ping-ponging
// "what page were you on?" emails. user_email is denormalized at
// write time so a future account-delete leaves the report's
// identification intact for follow-up.
//
// Admin reads happen at /api/admin/bug-reports.
import { sql } from './_lib/db.js';
import { requireUser, ensureWorkspace } from './_lib/auth.js';
import { readBody } from './_lib/body.js';
import { enforce, getClientIp } from './_lib/rate-limit.js';
import { requireSameOrigin } from './_lib/security.js';
import { badRequest, created, methodNotAllowed, serverError } from './_lib/json.js';

const VALID_SEVERITY = new Set(['info', 'minor', 'major', 'critical']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    // Per-user spam guard. 20 reports/hour is generous for a real beta
    // tester chasing a flaky bug + tight enough to stop a stuck client
    // from carpet-bombing the inbox.
    const blocked = await enforce(req, res, [
      { key: `bug:user:${user.id}`, max: 20, windowSeconds: 60 * 60 },
      { key: `bug:ip:${getClientIp(req)}`, max: 30, windowSeconds: 60 * 60 },
    ]);
    if (blocked) return;

    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 200);
    if (!title) return badRequest(res, 'Title is required');
    const descBody = body.body ? String(body.body).slice(0, 4000) : null;
    const severity = VALID_SEVERITY.has(body.severity) ? body.severity : 'minor';
    const url = body.url ? String(body.url).slice(0, 500) : null;
    const viewport = body.viewport ? String(body.viewport).slice(0, 32) : null;
    const appVersion = body.appVersion ? String(body.appVersion).slice(0, 64) : null;
    const userAgent = req.headers?.['user-agent']?.toString().slice(0, 500) || null;

    // Best-effort workspace lookup — non-owner users (clients) hit
    // this endpoint too, in which case workspace_id stays null.
    let workspaceId = null;
    try {
      const ws = await sql`SELECT id FROM workspaces WHERE owner_id = ${user.id} LIMIT 1`;
      workspaceId = ws.rows[0]?.id || null;
    } catch { /* ignore */ }

    const ins = await sql`
      INSERT INTO bug_reports (
        user_id, user_email, workspace_id, url, title, body,
        severity, user_agent, viewport, app_version
      ) VALUES (
        ${user.id}, ${user.email}, ${workspaceId},
        ${url}, ${title}, ${descBody},
        ${severity}, ${userAgent}, ${viewport}, ${appVersion}
      )
      RETURNING id, created_at
    `;
    return created(res, { id: ins.rows[0].id, createdAt: ins.rows[0].created_at });
  } catch (err) {
    return serverError(res, err);
  }
}
