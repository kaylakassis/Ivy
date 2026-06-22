// GET/POST /api/unsubscribe?token=...
//
// Public, unauthenticated. Honors the List-Unsubscribe header that every
// non-critical Ivy OS email carries — RFC 8058 one-click on POST (Gmail /
// Apple Mail / Outlook inbox button), and a friendly confirmation page on
// GET (link-click from inside the email body / footer).
//
// The token is HMAC-signed (api/_lib/unsubscribeToken.js) and identifies:
//   • the recipient row (owner user, workspace client, or newsletter
//     subscriber)
//   • the email category being opted out of (or 'all')
//
// Mutates the right opt-out and returns:
//   • POST: 200 JSON { ok: true }                — what RFC 8058 expects
//   • GET:  200 HTML confirmation page           — what humans expect
//
// Critical sends (verification, password reset, security alerts, account
// deletion) deliberately do NOT carry an unsubscribe link, so flipping
// every preference here can't lock anyone out of their account.
import { sql } from './_lib/db.js';
import { verifyUnsubscribeToken } from './_lib/unsubscribeToken.js';
import { EMAIL_NOTIFY_TYPES } from './_lib/notificationPrefs.js';
import { reportError } from './_lib/monitoring.js';

const PAGE_OK = (label) => `<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Unsubscribed — Ivy OS</title>
<style>
  body{margin:0;background:#0D0E0C;color:#F3F3EE;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Helvetica,Arial,sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
  .card{max-width:480px;width:100%;background:#16181A;border:1px solid #262A2D;border-radius:16px;padding:36px 32px;text-align:center;}
  h1{margin:0 0 14px;font-family:'Fraunces',Georgia,serif;font-size:26px;font-weight:500;letter-spacing:-0.025em;color:#CFFF50;}
  p{margin:0 0 12px;line-height:1.6;font-size:15px;color:#C9CAC3;}
  small{display:block;margin-top:18px;font-size:12px;color:#8A8D85;}
  a{color:#CFFF50;text-decoration:none;}
</style></head>
<body><div class="card">
  <h1>You're unsubscribed</h1>
  <p>You won't receive any more ${label} from us.</p>
  <p>Changed your mind? <a href="${process.env.APP_URL || 'https://getivyos.com'}/account?tab=notifications">Manage preferences</a>.</p>
  <small>— Ivy OS</small>
</div></body></html>`;

const PAGE_BAD = `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Link expired</title>
<style>body{margin:0;background:#0D0E0C;color:#F3F3EE;font-family:-apple-system,BlinkMacSystemFont,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center;}</style>
</head><body><div><h1>That unsubscribe link is invalid or expired.</h1>
<p>Reply to any email from us with "unsubscribe" and we'll handle it manually.</p></div></body></html>`;

async function applyOptOut(payload) {
  const { s: scope, i: id, w: workspaceId, t: type } = payload;
  const types = (type === 'all' || !type) ? EMAIL_NOTIFY_TYPES : [type];

  if (scope === 'user') {
    // Merge a `{ email_<type>: false }` patch into users.notification_prefs.
    const patch = {};
    for (const t of types) patch[`email_${t}`] = false;
    await sql`
      UPDATE users
         SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
       WHERE id = ${id}
    `;
    return { ok: true, label: 'emails of this kind' };
  }

  if (scope === 'client') {
    // clients.notification_prefs uses bare type keys (no email_ prefix).
    const patch = {};
    for (const t of types) patch[t] = false;
    await sql`
      UPDATE clients
         SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
       WHERE id = ${id}
    `;
    return { ok: true, label: 'these emails' };
  }

  if (scope === 'clientEmail') {
    if (!workspaceId) return { ok: false };
    const patch = {};
    for (const t of types) patch[t] = false;
    // Update every client row in this workspace matching that email.
    await sql`
      UPDATE clients
         SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
       WHERE workspace_id = ${workspaceId}
         AND LOWER(email) = LOWER(${id})
    `;
    return { ok: true, label: 'these emails' };
  }

  if (scope === 'newsletter') {
    // id is the email address for newsletter sign-ups.
    await sql`
      UPDATE newsletter_subscribers
         SET unsubscribed_at = NOW()
       WHERE LOWER(email) = LOWER(${id})
    `;
    return { ok: true, label: 'the newsletter' };
  }

  return { ok: false };
}

export default async function handler(req, res) {
  // RFC 8058 one-click: clients (Gmail in particular) POST with
  // `List-Unsubscribe=One-Click` in the body. We accept both POST and GET.
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  const token = (req.query && req.query.token) || '';
  const payload = verifyUnsubscribeToken(String(token));

  if (!payload) {
    if (req.method === 'POST') return res.status(400).json({ error: 'invalid token' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(PAGE_BAD);
  }

  let result = { ok: false, label: 'these emails' };
  try {
    result = await applyOptOut(payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[unsubscribe] apply failed:', err.message);
    try { reportError(err, { extra: { scope: payload.s } }); } catch { /* ignore */ }
  }

  if (req.method === 'POST') {
    // RFC 8058 expects a 2xx with anything; JSON keeps it machine-readable.
    return res.status(200).json({ ok: result.ok });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(PAGE_OK(result.label));
}
