// GET /api/cancellation-policy/record?id=<acceptance id>
//
// Owner only. A printable, self-contained page with everything about one
// acceptance (who, when, IP, browser, the fees in effect and the exact
// policy text with its SHA-256 fingerprint), meant to be saved as a PDF
// and attached to a payment dispute. Not cached, never indexed.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { serializeAcceptance, renderAcceptanceRecordHtml } from '../_lib/cancellationPolicy.js';
import { methodNotAllowed, serverError } from '../_lib/json.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'");
  return res.end(html);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;
    const id = String(req.query.id || '');
    if (!UUID.test(id)) return page(res, 400, '<!doctype html><title>Not found</title><p>Record not found.</p>');

    const { rows } = await sql`
      SELECT a.*, c.name AS client_name, c.email AS client_email, cs.biz_name, cs.timezone, w.name AS ws_name
        FROM cancellation_policy_acceptances a
        LEFT JOIN client_merges cm ON cm.workspace_id = a.workspace_id AND cm.removed_client_id = a.client_id
        LEFT JOIN clients c ON c.id = COALESCE(cm.current_client_id, a.client_id) AND c.workspace_id = a.workspace_id
        LEFT JOIN calendar_settings cs ON cs.workspace_id = a.workspace_id
        LEFT JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.id = ${id} AND a.workspace_id = ${workspaceId}
       LIMIT 1
    `;
    const r = rows[0];
    if (!r) return page(res, 404, '<!doctype html><title>Not found</title><p>Record not found.</p>');
    return page(res, 200, renderAcceptanceRecordHtml({
      acceptance: serializeAcceptance(r),
      businessName: r.biz_name || r.ws_name || '',
      clientName: r.client_name || r.name_entered || '',
      clientEmail: r.client_email || r.email_entered || '',
      timezone: r.timezone || 'UTC',
    }));
  } catch (err) {
    return serverError(res, err);
  }
}
