// POST /api/bug-reports   body: { title, body?, severity?, url?, viewport?, appVersion? }
//
// User-side "Report a bug" submission. Captures the description from
// the user plus context (URL they were on, browser, viewport, app
// version) so the super-admin can triage without ping-ponging
// "what page were you on?" emails. user_email is denormalized at
// write time so a future account-delete leaves the report's
// identification intact for follow-up.
//
// On submit we also fire-and-forget a notification email to every
// configured super-admin (SUPER_ADMIN_EMAIL + user_type='super_admin')
// so a fresh report doesn't require manually refreshing /admin/bugs.
//
// Admin reads happen at /api/admin/bug-reports.
import { sql } from './_lib/db.js';
import { requireUser, ensureWorkspace } from './_lib/auth.js';
import { readBody } from './_lib/body.js';
import { enforce, getClientIp } from './_lib/rate-limit.js';
import { requireSameOrigin } from './_lib/security.js';
import { sendEmail, emailShell } from './_lib/email.js';
import { superAdminEmails } from './_lib/admin.js';
import { appUrl } from './_lib/tokens.js';
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

    // Best-effort workspace lookup - non-owner users (clients) hit
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

    // Fire-and-forget super-admin email so a new bug doesn't require
    // refreshing /admin/bugs to spot. Never blocks the 201.
    notifyAdminOfBug({
      id: ins.rows[0].id, severity, title, body: descBody, url,
      reporterEmail: user.email, viewport, appVersion, userAgent,
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[bug-reports] admin notify failed:', e.message);
    });

    return created(res, { id: ins.rows[0].id, createdAt: ins.rows[0].created_at });
  } catch (err) {
    return serverError(res, err);
  }
}

// Look up super-admin emails from BOTH sources we use elsewhere:
//   • SUPER_ADMIN_EMAIL env (operator allowlist)
//   • users with user_type='super_admin' (DB-promoted)
// Dedup + lowercase before sending.
async function resolveAdminRecipients() {
  const envEmails = superAdminEmails();
  let dbEmails = [];
  try {
    const r = await sql`SELECT email FROM users WHERE user_type = 'super_admin' AND deleted_at IS NULL`;
    dbEmails = r.rows.map((x) => String(x.email || '').toLowerCase().trim()).filter(Boolean);
  } catch { /* ignore */ }
  return Array.from(new Set([...envEmails, ...dbEmails]));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function notifyAdminOfBug({ id, severity, title, body, url, reporterEmail, viewport, appVersion, userAgent }) {
  const to = await resolveAdminRecipients();
  if (to.length === 0) return;
  const sevLabel = severity.toUpperCase();
  const sevColor = severity === 'critical' ? '#FF5C5C'
    : severity === 'major' ? '#FFA040'
    : severity === 'minor' ? '#CFFF50' : '#8A8D85';
  const detailRows = [
    ['Severity',    `<span style="color:${sevColor};font-weight:600;">${escapeHtml(sevLabel)}</span>`],
    ['Reporter',    escapeHtml(reporterEmail || '(unknown)')],
    ['Page',        url ? `<a href="${escapeHtml(url)}" style="color:#CFFF50;text-decoration:underline;">${escapeHtml(url)}</a>` : '(not provided)'],
    ['Viewport',    escapeHtml(viewport || '(not provided)')],
    ['App version', escapeHtml(appVersion || '(not provided)')],
    ['User agent',  escapeHtml((userAgent || '').slice(0, 200)) || '(not provided)'],
  ].map(([k, v]) => `<tr><td style="color:#8A8D85;padding:4px 16px 4px 0;vertical-align:top;white-space:nowrap;">${k}</td><td style="color:#F3F3EE;padding:4px 0;">${v}</td></tr>`).join('');

  const html = emailShell({
    heading: `New bug report: ${title}`,
    preheader: `${sevLabel} severity — from ${reporterEmail || 'an Ivy user'}.`,
    body: `<p>A new bug report just came in.</p>
      ${body ? `<blockquote style="margin:14px 0;padding:12px 16px;border-left:3px solid #CFFF50;background:#1D2022;border-radius:6px;font-size:14px;line-height:1.55;color:#F3F3EE;white-space:pre-wrap;">${escapeHtml(body)}</blockquote>` : '<p style="color:#8A8D85;">(no description provided)</p>'}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px;font-size:13px;line-height:1.7;">${detailRows}</table>`,
    ctaText: 'Open in admin',
    ctaUrl: `${appUrl()}/admin?tab=bugs`,
    footer: `You're getting this because your email is on SUPER_ADMIN_EMAIL or your account is user_type='super_admin'. — Ivy`,
  });
  await sendEmail({
    to,
    subject: `[Bug · ${sevLabel}] ${title}`,
    html,
    replyTo: reporterEmail || undefined,
  });
}
