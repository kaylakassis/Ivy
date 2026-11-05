// GET/POST /api/unsubscribe?token=...
//
// Public, unauthenticated. Honors the List-Unsubscribe header that every
// non-critical Ivy email carries: RFC 8058 one-click on POST (Gmail /
// Apple Mail / Outlook inbox button), and a friendly confirmation page on
// GET (link-click from inside the email body / footer).
//
// The token is HMAC-signed (api/_lib/unsubscribeToken.js) and identifies:
//   • the recipient row (owner user, workspace client, client address,
//     newsletter or waitlist subscriber)
//   • the email category being opted out of (or 'all')
//
// Mutates the right opt-out and returns:
//   • POST: 200 JSON { ok: true }                (what RFC 8058 expects)
//   • GET:  200 HTML confirmation page           (what humans expect)
//
// Both are idempotent: a second hit leaves the same state and, because
// nothing changed, records nothing and notifies nobody.
//
// A client opting out of a business's emails (scopes client/clientEmail)
// goes through api/_lib/clientOptouts.js, which also applies it to every
// clients row of that business with the same address, records it, and
// tells the owner. Owner, newsletter and waitlist opt-outs notify nobody.
//
// Critical sends (verification, password reset, security alerts, account
// deletion, receipts) deliberately do NOT carry an unsubscribe link, so
// flipping every preference here can't lock anyone out of their account.
import { sql } from './_lib/db.js';
import { verifyUnsubscribeToken } from './_lib/unsubscribeToken.js';
import { EMAIL_NOTIFY_TYPES } from './_lib/notificationPrefs.js';
import { applyClientOptOut, optOutLabel } from './_lib/clientOptouts.js';
import { fetchBranding } from './_lib/branding.js';
import { reportError } from './_lib/monitoring.js';
import { setMarketingConsent } from './_lib/emailConsent.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STYLE = `body{margin:0;background:#012B24;color:#ECF0F1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Helvetica,Arial,sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;box-sizing:border-box;}
  .card{max-width:480px;width:100%;background:#04352D;border:1px solid #164B3F;border-radius:16px;padding:36px 32px;text-align:center;box-sizing:border-box;}
  h1{margin:0 0 14px;font-family:'Neue Haas Grotesk Display','Helvetica Neue',Helvetica,Arial,sans-serif;font-size:26px;font-weight:500;letter-spacing:-0.025em;color:#5CC98E;}
  p{margin:0 0 12px;line-height:1.6;font-size:15px;color:#C5D1CE;}
  small{display:block;margin-top:18px;font-size:12px;color:#93A3A0;}
  a{color:#5CC98E;text-decoration:none;}`;

// { line, note, prefsPath } fill the confirmation card.
const PAGE_OK = ({ line, note, prefsPath }) => `<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Unsubscribed</title>
<style>${STYLE}</style></head>
<body><div class="card">
  <h1>You're unsubscribed</h1>
  <p>${esc(line)}</p>
  ${note ? `<p>${esc(note)}</p>` : ''}
  ${prefsPath ? `<p>Changed your mind? <a href="${process.env.APP_URL || 'https://joinivy.ai'}${prefsPath}">Manage preferences</a>.</p>` : ''}
  <small>Ivy</small>
</div></body></html>`;

const PAGE_BAD = `<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Link expired</title>
<style>${STYLE}</style>
</head><body><div class="card"><h1>That unsubscribe link is invalid or expired.</h1>
<p>Reply to any email from us with "unsubscribe" and we'll handle it manually.</p></div></body></html>`;

function normalizeType(type) {
  return (type && type !== 'all' && EMAIL_NOTIFY_TYPES.includes(type)) ? type : 'all';
}

async function applyOptOut(payload, source) {
  const { s: scope, i: id, w: workspaceId } = payload;
  const type = normalizeType(payload.t);
  const types = type === 'all' ? EMAIL_NOTIFY_TYPES : [type];

  if (scope === 'user') {
    // Merge a `{ email_<type>: false }` patch into users.notification_prefs.
    // A deleted user matches no row: nothing to do, same friendly page.
    const patch = {};
    for (const t of types) patch[`email_${t}`] = false;
    await sql`
      UPDATE users
         SET notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
       WHERE id = ${id}
    `;
    // Unsubscribing from Ivy's marketing (or from everything) also
    // withdraws the marketing consent given at sign-up or in settings, so
    // the person drops off the admin marketing list too.
    if (type === 'marketing' || type === 'all') {
      await setMarketingConsent(null, { userId: id, on: false, source: 'unsubscribe' });
    }
    return {
      line: type === 'all'
        ? "You won't get any more emails from Ivy, apart from account and security notices."
        : `You won't get any more ${optOutLabel(type)} from Ivy.`,
      prefsPath: '/account?tab=notifications',
    };
  }

  if (scope === 'client' || scope === 'clientEmail') {
    if (scope === 'clientEmail' && !workspaceId) return null;
    const r = await applyClientOptOut({
      workspaceId: scope === 'clientEmail' ? workspaceId : null,
      clientId: scope === 'client' ? id : null,
      email: scope === 'clientEmail' ? id : null,
      type,
      source,
    });
    const wsId = r.subject?.workspaceId || workspaceId;
    let business = 'This business';
    if (wsId) {
      const b = await fetchBranding(wsId).catch(() => ({}));
      if (b?.businessName) business = b.businessName;
    }
    return {
      line: `${business} won't send you any more ${optOutLabel(type)}.`,
      note: "You'll still get receipts and other account essentials.",
      prefsPath: '/me/notifications',
    };
  }

  if (scope === 'waitlist') {
    // id is the email address. Skipped by every waitlist send from now on.
    await sql`
      UPDATE waitlist_signups
         SET unsubscribed_at = COALESCE(unsubscribed_at, NOW())
       WHERE LOWER(email) = LOWER(${id})
    `;
    return { line: "You won't get any more waitlist emails from Ivy." };
  }

  if (scope === 'newsletter') {
    // id is the email address for newsletter sign-ups.
    await sql`
      UPDATE newsletter_subscribers
         SET unsubscribed_at = COALESCE(unsubscribed_at, NOW())
       WHERE LOWER(email) = LOWER(${id})
    `;
    return { line: "You won't get the Ivy newsletter any more." };
  }

  return null;
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

  let result = null;
  let failed = false;
  try {
    result = await applyOptOut(payload, req.method === 'POST' ? 'one_click' : 'link');
  } catch (err) {
    failed = true;
    // eslint-disable-next-line no-console
    console.error('[unsubscribe] apply failed:', err.message);
    try { reportError(err, { extra: { scope: payload.s } }); } catch { /* ignore */ }
  }

  if (req.method === 'POST') {
    // RFC 8058 expects a 2xx with anything; JSON keeps it machine-readable.
    return res.status(200).json({ ok: !failed && !!result });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (failed || !result) {
    // Never claim success when nothing was saved.
    return res.status(500).send(PAGE_BAD.replace('That unsubscribe link is invalid or expired.', "We couldn't save that just now. Please try the link again."));
  }
  return res.status(200).send(PAGE_OK(result));
}
