// Is this business still open to the public and to its clients?
//
// When an owner's subscription is no longer active (ended trial,
// cancelled, suspended, lapsed period) everything their CLIENTS could
// reach is archived, not just the owner's dashboard: the public booking
// page, the website, the client-portal composer, every public checkout.
// "Active" is exactly the paywall predicate (isWorkspaceActive), so the
// owner's wall and the client-facing archive can never disagree, and
// reactivation flips everything back on its own. This is a STATE read
// off the workspace row - nothing here ever changes data.
//
// Endpoints call one of the loaders after they have resolved the
// workspace (so a missing slug/handle still 404s the way it always did),
// then either return `archivedPayload(access)` with a 200 for read
// surfaces (the page renders the archived card) or `archivedForbidden`
// with a 403 for writes (booking, contact, checkout, client message).
import { sql } from './db.js';
import { isWorkspaceActive } from './clientPortal.js';

export const ARCHIVED_MESSAGE = 'This business is no longer available to book with on Ivy.';
export const ARCHIVED_CODE = 'business_archived';
export const DISCOVER_PATH = '/me/discover';
// Absolute form for server-rendered HTML that may be served from a
// custom domain, where a relative /me/discover would point at the
// owner's domain instead of Ivy.
export const DISCOVER_URL = 'https://www.joinivy.ai/me/discover';

function shape(row) {
  if (!row) return { workspaceId: null, active: false, businessName: null };
  return {
    workspaceId: row.id,
    active: isWorkspaceActive(row),
    businessName: row.biz_name || row.workspace_name || 'This business',
  };
}

const SELECT = `
  SELECT w.id, w.name AS workspace_name,
         w.subscription_status, w.trial_ends_at, w.subscription_period_end, w.comp_until,
         cs.biz_name
    FROM workspaces w
    LEFT JOIN calendar_settings cs ON cs.workspace_id = w.id`;

export async function loadWorkspaceAccess(workspaceId) {
  if (!workspaceId) return shape(null);
  const { rows } = await sql.query(`${SELECT} WHERE w.id = $1 LIMIT 1`, [workspaceId]);
  return shape(rows[0]);
}

// By the booking-page handle (calendar_settings.slug).
export async function workspaceAccessBySlug(slug) {
  const s = String(slug || '').toLowerCase().trim();
  if (!s) return shape(null);
  const { rows } = await sql.query(`${SELECT} WHERE cs.slug = $1 LIMIT 1`, [s]);
  return shape(rows[0]);
}

// By the website handle (websites.handle).
export async function workspaceAccessByHandle(handle) {
  const h = String(handle || '').toLowerCase().trim();
  if (!h) return shape(null);
  const { rows } = await sql.query(
    `${SELECT} JOIN websites web ON web.workspace_id = w.id WHERE web.handle = $1 LIMIT 1`,
    [h],
  );
  return shape(rows[0]);
}

// 200 body for read endpoints: the page swaps its content for the
// archived card. No services, slots, pages or anything else leaks.
export function archivedPayload(access) {
  return { archived: true, businessName: access?.businessName || 'This business', discoverPath: DISCOVER_PATH };
}

// 403 for writes. `code` lets the UI tell this apart from other 403s
// (blocked threads use code 'blocked').
export function archivedForbidden(res) {
  console.warn('[api] 403 business_archived ·', res.req?.method, res.req?.url);
  return res.status(403).json({ error: ARCHIVED_MESSAGE, code: ARCHIVED_CODE });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal static page for the server-rendered site routes. No inline
// scripts (the site CSP has no 'unsafe-inline' for script-src; inline
// styles are allowed) and a noindex so search engines drop the page.
export function renderArchivedHtml({ businessName }) {
  const name = esc(businessName || 'This business');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>${name}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F6F5F1;color:#2A2924;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;box-sizing:border-box}
  .card{max-width:440px;width:100%;background:#fff;border:1px solid #E6E1D7;border-radius:16px;padding:36px 32px;text-align:center;box-shadow:0 12px 32px -18px rgba(0,0,0,.25)}
  h1{margin:0 0 10px;font-size:22px;font-weight:600;letter-spacing:-.01em}
  p{margin:0;font-size:15px;line-height:1.55;color:#5C5952}
  p+p{margin-top:8px}
  a.btn{display:inline-block;margin-top:22px;padding:12px 22px;border-radius:10px;background:#8E826A;color:#fff;text-decoration:none;font-weight:600;font-size:14px}
</style>
</head>
<body>
<main class="card">
  <h1>${name}</h1>
  <p>${esc(ARCHIVED_MESSAGE)}</p>
  <p>Want to see what else is out there?</p>
  <a class="btn" href="${DISCOVER_URL}">Check out Discover</a>
</main>
</body>
</html>`;
}
