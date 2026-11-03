// Unsubscribe audit: anyone who unsubscribes is truly unsubscribed, and a
// business owner hears about it when one of their clients opts out.
//
//   [1] optional email paths: opted-in gets the email with a working
//       one-click unsubscribe; opted-out gets nothing
//       (lead auto-reply, website newsletter campaign, owner prospect
//       message, owner form-submission notice, a booking email with no
//       clients row, duplicate client rows, waitlist confirmation)
//   [2] critical sends: receipts reach an unsubscribed client and carry no
//       unsubscribe link; a raw send never advertises one-click
//   [3] owner notice: link (GET), one-click (POST) and portal each record a
//       client_email_optouts row and notify the owner once (email + bell/push);
//       repeats are idempotent; two opt-outs the same day give one email
//   [4] isolation: another business is unaffected and not notified; the
//       owner's own opt-out, newsletter and waitlist opt-outs notify nobody;
//       owner can mute the notice; a deleted client's link is friendly
//   [5] client portal reflects opt-outs and resubscribing works; the owner
//       drawer endpoint is read-only history
//   [6] push: owner nudges carry a push type the owner can mute
//   [7] SMS STOP matches a formatted phone number
//
// Run: node --import ./tests/bootstrap.mjs ./tests/unsubscribe-audit.test.mjs
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.IVY_TWILIO_ACCOUNT_SID = 'AC_unsub_audit';
process.env.IVY_TWILIO_AUTH_TOKEN = 'unsub_audit_twilio_token';
process.env.IVY_TWILIO_FROM_NUMBER = '+15005550006';

import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import unsubscribeHandler from '../api/unsubscribe.js';
import { mintUnsubscribeToken } from '../api/_lib/unsubscribeToken.js';
import { sendEmail, sendEmailToClient, sendEmailToClientByAddress, emailShell } from '../api/_lib/email.js';
import { notifyLeadInstantReply } from '../api/_lib/leadNotify.js';
import { sendCampaign } from '../api/_lib/campaigns.js';
import { notifyBookingCancellation } from '../api/_lib/bookingNotify.js';
import { notifyInvoicePaid } from '../api/_lib/invoiceNotify.js';
import { notifyDormantOwner } from '../api/_lib/subscriptionNotify.js';
import contactHandler from '../api/calendar/public/contact.js';
import formSubmission from '../api/website/form-submission.js';
import waitlistJoin from '../api/waitlist/join.js';
import portalPrefs from '../api/me/notifications-clients.js';
import optoutsEndpoint from '../api/clients/[id]/email-optouts.js';
import smsInbound from '../api/sms/inbound.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

// Capture outbound Resend calls instead of sending.
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('resend.com')) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const to = (m) => (Array.isArray(m.to) ? m.to : [m.to]).map((x) => String(x).toLowerCase());
const mailsTo = (addr) => sent.filter((m) => to(m).includes(addr.toLowerCase()));
const headersOf = (m) => m.headers || {};
const hasOneClick = (m) => /\/api\/unsubscribe\?token=/.test(headersOf(m)['List-Unsubscribe'] || '')
  && headersOf(m)['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click';
const tokenFrom = (html, all = false) => {
  const m = [...String(html).matchAll(/\/api\/unsubscribe\?token=([A-Za-z0-9_\-.]+)/g)].map((x) => x[1]);
  return all ? m[1] : m[0];
};

const mkRes = () => {
  const r = { statusCode: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.getHeader = (k) => r.headers[k.toLowerCase()];
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.end = (b) => { if (b !== undefined) r.body = b; return r; };
  return r;
};
const hit = async (token, method = 'GET') => {
  const res = mkRes();
  await unsubscribeHandler({ method, query: { token }, headers: {} }, res);
  return res;
};
let ipN = 0;
const ip = () => `203.0.113.${(ipN++ % 200) + 20}`;
const authReq = ({ method = 'GET', body, query = {}, cookie }) => ({
  method, url: '/test', query, body,
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', cookie, 'x-forwarded-for': ip() },
});

const created = { users: [], workspaces: [] };
async function mkOwner(name, biz) {
  const email = `ua-${name}-${S}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${name}, NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0];
  const w = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, ${biz}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0];
  const slug = `ua-${name}-${S}`.toLowerCase();
  await sql`INSERT INTO calendar_settings (workspace_id, slug, biz_name) VALUES (${w.id}, ${slug}, ${biz})
            ON CONFLICT (workspace_id) DO UPDATE SET slug = EXCLUDED.slug, biz_name = EXCLUDED.biz_name`;
  created.users.push(u.id); created.workspaces.push(w.id);
  return { id: u.id, email, ws: w.id, slug, biz };
}
async function mkClient(ws, name, email, userId = null) {
  return (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${ws}, ${name}, ${email}, 'active', ${userId}) RETURNING id`).rows[0].id;
}
const optRows = async (ws) => (await sql`SELECT * FROM client_email_optouts WHERE workspace_id = ${ws} ORDER BY created_at`).rows;
const bell = async (userId) => (await sql`SELECT * FROM notifications WHERE user_id = ${userId} AND type = 'client_optouts'`).rows;
const html = emailShell({ heading: 'Hello', body: '<p>News</p>' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await ensureSchemaApplied();
  const A = await mkOwner('alpha', 'Alpha Studio');
  const B = await mkOwner('beta', 'Beta Spa');

  // ─────────────────────────────────────────────────────────────────
  console.log('\n[1a] lead auto-reply: one-click works for an address with no clients row');
  const lead = `ua-lead-${S}@example.com`;
  sent.length = 0;
  let r = await notifyLeadInstantReply({ workspaceId: A.ws, toEmail: lead, leadName: 'Lee Lead' });
  assert(r.sent === true && mailsTo(lead).length === 1, 'opted-in lead gets the auto-reply');
  assert(hasOneClick(mailsTo(lead)[0]), 'auto-reply carries signed List-Unsubscribe + One-Click');
  let res = await hit(tokenFrom(mailsTo(lead)[0].html), 'POST');
  assert(res.statusCode === 200 && res.body?.ok === true, 'one-click POST accepted');
  sent.length = 0;
  r = await notifyLeadInstantReply({ workspaceId: A.ws, toEmail: lead, leadName: 'Lee Lead' });
  assert(r.sent === false && mailsTo(lead).length === 0, 'unsubscribed lead gets nothing (no clients row needed)');
  const leadRow = (await optRows(A.ws)).find((x) => x.email === lead);
  assert(leadRow && leadRow.client_id === null && leadRow.type === 'messages' && leadRow.source === 'one_click', 'address-only opt-out recorded');
  // A clients row created later for that address inherits the opt-out.
  const leadClient = await mkClient(A.ws, 'Lee Lead', lead);
  r = await sendEmailToClient({ clientId: leadClient, type: 'messages', to: lead, subject: 'x', html });
  assert(r.sent === false && r.reason === 'muted', 'a clients row created later stays unsubscribed');

  console.log('\n[1b] website newsletter campaign (no clients row) honours one-click');
  const sub = `ua-news-${S}@example.com`;
  const site = (await sql`INSERT INTO websites (workspace_id, handle, business_name, published_at)
    VALUES (${A.ws}, ${`ua-site-${S}`}, 'Alpha Studio', NOW()) RETURNING id`).rows[0];
  await sql`INSERT INTO website_form_submissions (website_id, form_id, payload) VALUES (${site.id}, 'newsletter', ${JSON.stringify({ email: sub, name: 'Nia' })}::jsonb)`;
  sent.length = 0;
  let c = await sendCampaign({ workspaceId: A.ws, campaign: { subject: 'Spring news', body: 'Hello', audience: 'newsletter' } });
  assert(c.sent === 1 && mailsTo(sub).length === 1 && hasOneClick(mailsTo(sub)[0]), 'subscriber gets the campaign with one-click headers');
  await hit(tokenFrom(mailsTo(sub)[0].html, true), 'POST');
  sent.length = 0;
  c = await sendCampaign({ workspaceId: A.ws, campaign: { subject: 'Summer news', body: 'Hello', audience: 'newsletter' } });
  assert(c.sent === 0 && c.skipped === 1 && mailsTo(sub).length === 0, 'after one-click the next campaign skips them');

  console.log('\n[1c] owner prospect-message email follows the owner\'s Messages switch');
  sent.length = 0;
  res = mkRes();
  await contactHandler({ method: 'POST', query: { slug: A.slug }, body: { name: 'Pat Prospect', email: `ua-pat-${S}@example.com`, message: 'Do you have Fridays?' }, headers: { 'x-forwarded-for': ip(), host: 'localhost:3000' } }, res);
  assert(res.statusCode === 200, `contact accepted (${res.statusCode})`);
  const ownerMsg = mailsTo(A.email).find((m) => /question about booking/.test(m.subject));
  assert(!!ownerMsg && hasOneClick(ownerMsg), 'opted-in owner gets the prospect email with one-click headers');
  await sql`UPDATE users SET notification_prefs = '{"email_messages": false}'::jsonb WHERE id = ${A.id}`;
  sent.length = 0;
  res = mkRes();
  await contactHandler({ method: 'POST', query: { slug: A.slug }, body: { name: 'Pat Two', email: `ua-pat2-${S}@example.com`, message: 'And Saturdays?' }, headers: { 'x-forwarded-for': ip(), host: 'localhost:3000' } }, res);
  assert(res.statusCode === 200 && !mailsTo(A.email).some((m) => /question about booking/.test(m.subject)), 'owner who muted message emails gets none');

  console.log('\n[1d] website form submission to the owner follows the same switch');
  sent.length = 0;
  res = mkRes();
  await formSubmission({ method: 'POST', url: '/api/website/form-submission', query: {}, body: JSON.stringify({ handle: `ua-site-${S}`, formId: 'contact', payload: { name: 'Fay', email: `ua-fay-${S}@example.com`, message: 'Hi' } }), headers: { 'content-type': 'application/json', host: 'localhost:3000', 'x-forwarded-for': ip() } }, res);
  assert(res.statusCode === 200 && !mailsTo(A.email).some((m) => /submission/.test(m.subject)), 'muted owner: no submission email');
  const fsRow = (await sql`SELECT delivered, delivery_err FROM website_form_submissions WHERE website_id = ${site.id} AND form_id = 'contact' ORDER BY submitted_at DESC LIMIT 1`).rows[0];
  assert(fsRow && fsRow.delivered === false && /turned off/.test(fsRow.delivery_err || ''), 'submission kept with the reason');
  await sql`UPDATE users SET notification_prefs = '{}'::jsonb WHERE id = ${A.id}`;
  sent.length = 0;
  res = mkRes();
  await formSubmission({ method: 'POST', url: '/api/website/form-submission', query: {}, body: JSON.stringify({ handle: `ua-site-${S}`, formId: 'contact', payload: { name: 'Fay', email: `ua-fay-${S}@example.com`, message: 'Hi again' } }), headers: { 'content-type': 'application/json', host: 'localhost:3000', 'x-forwarded-for': ip() } }, res);
  const fsMail = mailsTo(A.email).find((m) => /submission/.test(m.subject));
  assert(!!fsMail && hasOneClick(fsMail), 'opted-in owner gets it with one-click headers');

  console.log('\n[1e] a booking email with no clients row is gated by address');
  const walkIn = `ua-walkin-${S}@example.com`;
  const bk = (await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
    VALUES (${A.ws}, NULL, 'Walk In', ${walkIn}, CURRENT_DATE + 3, 600, 660) RETURNING id`).rows[0].id;
  sent.length = 0;
  await notifyBookingCancellation({ workspaceId: A.ws, bookingId: bk, source: 'owner' });
  const cancelMail = mailsTo(walkIn)[0];
  assert(!!cancelMail && hasOneClick(cancelMail), 'opted-in walk-in gets the cancellation with a working unsubscribe');
  await hit(mintUnsubscribeToken({ scope: 'clientEmail', id: walkIn, workspaceId: A.ws, type: 'bookings' }), 'GET');
  sent.length = 0;
  await notifyBookingCancellation({ workspaceId: A.ws, bookingId: bk, source: 'owner' });
  assert(mailsTo(walkIn).length === 0, 'after unsubscribing, the walk-in gets no booking email');

  console.log('\n[1f] duplicate clients rows: an opt-out on one row mutes the other');
  const dup = `ua-dup-${S}@example.com`;
  const d1 = await mkClient(A.ws, 'Dee One', dup);
  const d2 = await mkClient(A.ws, 'Dee Two', dup.toUpperCase());
  await hit(mintUnsubscribeToken({ scope: 'client', id: d1, type: 'marketing' }), 'GET');
  r = await sendEmailToClient({ clientId: d2, type: 'marketing', to: dup, subject: 'Promo', html });
  assert(r.sent === false && r.reason === 'muted', 'sibling row is muted too');
  sent.length = 0;
  c = await sendCampaign({ workspaceId: A.ws, campaign: { subject: 'All clients', body: 'Hi', audience: 'all-clients' } });
  assert(mailsTo(dup).length === 0, 'all-clients campaign skips the unsubscribed address');

  console.log('\n[1g] waitlist confirmation carries a working one-click link');
  const wl = `ua-wl-${S}@example.com`;
  sent.length = 0;
  res = mkRes();
  await waitlistJoin({ method: 'POST', url: '/api/waitlist/join', query: {}, body: { email: wl, firstName: 'Wren', lastName: 'Lane', consent: true },
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': ip() } }, res);
  const wlMail = mailsTo(wl)[0];
  assert(!!wlMail && hasOneClick(wlMail), 'confirmation has a signed one-click header');
  await hit(tokenFrom(wlMail.html), 'POST');
  const wlRow = (await sql`SELECT unsubscribed_at FROM waitlist_signups WHERE LOWER(email) = ${wl}`).rows[0];
  assert(!!wlRow?.unsubscribed_at, 'one-click stamped unsubscribed_at');

  // ─────────────────────────────────────────────────────────────────
  console.log('\n[2] critical sends');
  const rc = `ua-receipt-${S}@example.com`;
  const rcId = await mkClient(A.ws, 'Rae Receipt', rc);
  await hit(mintUnsubscribeToken({ scope: 'client', id: rcId, type: 'all' }), 'GET');
  const inv = (await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, client_email, items, status, paid_at)
    VALUES (${A.ws}, ${`UA-${S}`}, ${rcId}, 'Rae Receipt', ${rc}, '[{"desc":"x","qty":1,"price":50}]'::jsonb, 'paid', NOW()) RETURNING id`).rows[0].id;
  sent.length = 0;
  await notifyInvoicePaid({ workspaceId: A.ws, invoiceId: inv, totalAmount: 50, method: 'card' });
  const receipt = mailsTo(rc)[0];
  assert(!!receipt, 'a client unsubscribed from all emails still gets the payment receipt');
  assert(receipt && !/\/api\/unsubscribe/.test(receipt.html) && !headersOf(receipt)['List-Unsubscribe-Post'], 'the receipt carries no unsubscribe link and no one-click claim');
  sent.length = 0;
  await sendEmail({ to: `ua-raw-${S}@example.com`, subject: 'Reset', html });
  assert(sent[0] && !sent[0].headers['List-Unsubscribe-Post'] && /List-Unsubscribe/.test(Object.keys(sent[0].headers).join()), 'a raw critical send keeps List-Unsubscribe but never claims one-click');

  // ─────────────────────────────────────────────────────────────────
  console.log('\n[3] owner notice: link, one-click, portal');
  const cl = `ua-cleo-${S}@example.com`;
  const cleo = await mkClient(A.ws, 'Cleo Client', cl);
  sent.length = 0;
  r = await sendEmailToClient({ clientId: cleo, type: 'marketing', to: cl, subject: 'Promo', html });
  assert(r.sent && hasOneClick(sent[0]), 'opted-in client gets marketing with one-click headers');
  const cleoLink = tokenFrom(sent[0].html);
  const bellBefore = (await bell(A.id)).length;
  sent.length = 0;
  res = await hit(cleoLink, 'GET');
  assert(res.statusCode === 200 && /unsubscribed/i.test(res.body) && /Alpha Studio/.test(res.body) && !/—/.test(res.body), 'link: friendly page names the business, no em dash');
  let rows = (await optRows(A.ws)).filter((x) => x.client_id === cleo);
  assert(rows.length === 1 && rows[0].type === 'marketing' && rows[0].source === 'link', 'link: one client_email_optouts row (marketing, link)');
  let ownerMails = mailsTo(A.email).filter((m) => /unsubscribed/.test(m.subject));
  assert(ownerMails.length === 1, 'link: owner emailed once');
  const om = ownerMails[0];
  assert(om && /Cleo Client/.test(om.html) && /reviews and announcements/.test(om.html) && /Alpha Studio/.test(om.html)
    && /still get account essentials like receipts/.test(om.html) && /through Messages in Ivy/.test(om.html)
    && om.html.includes(`/clients?id=${cleo}`), 'owner email has the copy and a link to the client');
  assert(om && hasOneClick(om) && /client_optouts|t%22%3A%22client_optouts/.test(Buffer.from(tokenFrom(om.html).split('.')[0], 'base64').toString()), 'owner notice is itself unsubscribable (client_optouts)');
  assert((await bell(A.id)).length === bellBefore + 1, 'link: owner push/bell once');

  console.log('\n[3b] repeat of the same link is idempotent');
  const tokCleo = mintUnsubscribeToken({ scope: 'client', id: cleo, type: 'marketing' });
  sent.length = 0;
  res = await hit(tokCleo, 'GET');
  const res2 = await hit(tokCleo, 'POST');
  assert(res.statusCode === 200 && res2.statusCode === 200 && res2.body.ok === true, 'GET and POST again both succeed');
  assert((await optRows(A.ws)).filter((x) => x.client_id === cleo).length === 1, 'no new row');
  assert(mailsTo(A.email).length === 0 && (await bell(A.id)).length === bellBefore + 1, 'no new owner email or push');

  console.log('\n[3c] one-click "all" the same day: push, row, but no second email');
  res = await hit(mintUnsubscribeToken({ scope: 'client', id: cleo, type: 'all' }), 'POST');
  rows = (await optRows(A.ws)).filter((x) => x.client_id === cleo);
  assert(res.body.ok === true && rows.length === 2 && rows[1].type === 'all' && rows[1].source === 'one_click', 'one-click: row (all, one_click)');
  assert(mailsTo(A.email).length === 0, 'same client same day: still one owner email');
  assert((await bell(A.id)).length === bellBefore + 2, 'one-click: push for the new category');
  for (const t of ['bookings', 'documents', 'messages', 'programs', 'invoices']) {
    // eslint-disable-next-line no-await-in-loop
    r = await sendEmailToClient({ clientId: cleo, type: t, to: cl, subject: t, html });
    assert(r.sent === false, `after "all": ${t} muted`);
  }

  console.log('\n[3d] portal switch off notifies once; portal reflects state; resubscribe works');
  const portalEmail = `ua-port-${S}@example.com`;
  const pu = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${portalEmail}, 'x', 'Paz Portal', NOW(), '2026-05-05', NOW()) RETURNING id, email, email_verified_at`).rows[0];
  created.users.push(pu.id);
  const paz = await mkClient(A.ws, 'Paz Portal', portalEmail, pu.id);
  const cookie = `ivy_session=${signSession(pu.id)}`;
  sent.length = 0;
  const bell2 = (await bell(A.id)).length;
  res = mkRes();
  await portalPrefs(authReq({ method: 'PATCH', cookie, body: { clientId: paz, prefs: { bookings: false } } }), res);
  assert(res.statusCode === 200 && res.body.prefs.bookings === false, `portal: bookings off (${res.statusCode})`);
  rows = (await optRows(A.ws)).filter((x) => x.client_id === paz);
  assert(rows.length === 1 && rows[0].type === 'bookings' && rows[0].source === 'portal', 'portal: row (bookings, portal)');
  assert(mailsTo(A.email).filter((m) => /Paz Portal/.test(m.subject)).length === 1, 'portal: owner emailed once');
  assert((await bell(A.id)).length === bell2 + 1, 'portal: owner push/bell once');
  r = await sendEmailToClient({ clientId: paz, type: 'bookings', to: portalEmail, subject: 'b', html });
  assert(r.sent === false, 'portal opt-out mutes bookings');
  // Same switch again: nothing new.
  res = mkRes();
  await portalPrefs(authReq({ method: 'PATCH', cookie, body: { clientId: paz, prefs: { bookings: false } } }), res);
  assert((await optRows(A.ws)).filter((x) => x.client_id === paz).length === 1, 'portal repeat: no new row');
  // An "all" link, then the portal shows everything off; turning one on works.
  await hit(mintUnsubscribeToken({ scope: 'client', id: paz, type: 'all' }), 'GET');
  res = mkRes();
  await portalPrefs(authReq({ method: 'GET', cookie }), res);
  const mem = (res.body.memberships || []).find((m) => m.clientId === paz);
  assert(mem && Object.values(mem.prefs).every((v) => v === false), 'portal GET reflects the "all" unsubscribe');
  assert(!res.body.emailTypes.includes('client_optouts') && !res.body.emailTypes.includes('reports'), 'portal does not offer owner-only categories');
  res = mkRes();
  await portalPrefs(authReq({ method: 'PATCH', cookie, body: { clientId: paz, prefs: { marketing: true } } }), res);
  assert(res.body.prefs.marketing === true && res.body.prefs.bookings === false && res.body.prefs.documents === false, 'resubscribe one category: only that one comes back');
  r = await sendEmailToClient({ clientId: paz, type: 'marketing', to: portalEmail, subject: 'm', html });
  assert(r.sent === true, 'resubscribed category sends again');
  r = await sendEmailToClient({ clientId: paz, type: 'documents', to: portalEmail, subject: 'd', html });
  assert(r.sent === false, 'other categories stay off');

  // ─────────────────────────────────────────────────────────────────
  console.log('\n[4] isolation and who is never notified');
  const shared = `ua-shared-${S}@example.com`;
  const sA = await mkClient(A.ws, 'Sam Shared', shared);
  const sB = await mkClient(B.ws, 'Sam Shared', shared);
  const bellB = (await bell(B.id)).length;
  sent.length = 0;
  await hit(mintUnsubscribeToken({ scope: 'clientEmail', id: shared, workspaceId: A.ws, type: 'all' }), 'POST');
  r = await sendEmailToClient({ clientId: sA, type: 'marketing', to: shared, subject: 'A promo', html });
  assert(r.sent === false, 'business A: muted');
  r = await sendEmailToClient({ clientId: sB, type: 'marketing', to: shared, subject: 'B promo', html });
  assert(r.sent === true, 'business B: still sends');
  r = await sendEmailToClientByAddress({ workspaceId: B.ws, email: shared, type: 'bookings', subject: 'B booking', html });
  assert(r.sent === true, 'business B by address: still sends');
  assert(mailsTo(B.email).length === 0 && (await bell(B.id)).length === bellB, 'business B owner not notified');
  assert(mailsTo(A.email).filter((m) => /Sam Shared/.test(m.subject)).length === 1, 'business A owner notified once');
  assert((await optRows(B.ws)).length === 0, 'no opt-out row for business B');

  console.log('\n[4b] owner can mute the notice');
  await sql`UPDATE users SET notification_prefs = '{"email_client_optouts": false}'::jsonb WHERE id = ${A.id}`;
  const quiet = await mkClient(A.ws, 'Quinn Quiet', `ua-quinn-${S}@example.com`);
  sent.length = 0;
  await hit(mintUnsubscribeToken({ scope: 'client', id: quiet, type: 'marketing' }), 'GET');
  assert(mailsTo(A.email).length === 0, 'owner who turned off client opt-out emails gets none');
  assert((await optRows(A.ws)).some((x) => x.client_id === quiet), 'the opt-out is still recorded');
  await sql`UPDATE users SET notification_prefs = '{}'::jsonb WHERE id = ${A.id}`;

  console.log('\n[4c] owner, newsletter and waitlist opt-outs notify nobody');
  const rowsBefore = (await optRows(A.ws)).length;
  const bellA = (await bell(A.id)).length;
  sent.length = 0;
  await hit(mintUnsubscribeToken({ scope: 'user', id: A.id, type: 'marketing' }), 'POST');
  await hit(mintUnsubscribeToken({ scope: 'newsletter', id: `ua-nl-${S}@example.com`, type: 'all' }), 'GET');
  await hit(mintUnsubscribeToken({ scope: 'waitlist', id: wl, type: 'all' }), 'GET');
  assert((await optRows(A.ws)).length === rowsBefore && (await bell(A.id)).length === bellA && sent.length === 0, 'no row, no push, no email');
  await sql`UPDATE users SET notification_prefs = '{}'::jsonb WHERE id = ${A.id}`;

  console.log('\n[4d] a deleted client\'s link is friendly');
  const gone = await mkClient(A.ws, 'Gone Client', `ua-gone-${S}@example.com`);
  const goneTok = mintUnsubscribeToken({ scope: 'client', id: gone, type: 'all' });
  await sql`DELETE FROM clients WHERE id = ${gone}`;
  res = await hit(goneTok, 'GET');
  assert(res.statusCode === 200 && /unsubscribed/i.test(res.body), 'GET: friendly confirmation page');
  res = await hit(goneTok, 'POST');
  assert(res.statusCode === 200 && res.body.ok === true, 'POST: 200 ok');
  const deletedUserTok = mintUnsubscribeToken({ scope: 'user', id: crypto.randomUUID(), type: 'all' });
  res = await hit(deletedUserTok, 'GET');
  assert(res.statusCode === 200, 'deleted owner token: friendly page');

  // ─────────────────────────────────────────────────────────────────
  console.log('\n[5] owner drawer: read-only history');
  const ownerCookie = `ivy_session=${signSession(A.id)}`;
  res = mkRes();
  await optoutsEndpoint(authReq({ method: 'GET', cookie: ownerCookie, query: { id: cleo } }), res);
  assert(res.statusCode === 200 && res.body.history.length === 2 && res.body.history[0].type === 'all' && res.body.ownerCanResubscribe === false, 'history lists the opt-outs, newest first');
  res = mkRes();
  await optoutsEndpoint(authReq({ method: 'POST', cookie: ownerCookie, query: { id: cleo } }), res);
  assert(res.statusCode === 405, 'no write method: owners cannot resubscribe a client');
  res = mkRes();
  await optoutsEndpoint(authReq({ method: 'GET', cookie: `ivy_session=${signSession(B.id)}`, query: { id: cleo } }), res);
  assert(res.statusCode === 404, "another business cannot read this client's history");

  // ─────────────────────────────────────────────────────────────────
  console.log('\n[6] owner nudge push carries a mutable type');
  await sql`INSERT INTO invoices (workspace_id, number, client_name, items, status) VALUES (${B.ws}, ${`UB-${S}`}, 'Someone', '[]'::jsonb, 'sent')`;
  await notifyDormantOwner({ workspaceId: B.ws });
  let nudge = null;
  for (let i = 0; i < 20 && !nudge; i++) {
    // eslint-disable-next-line no-await-in-loop
    nudge = (await sql`SELECT type FROM notifications WHERE user_id = ${B.id} AND tag = 'owner-reengage'`).rows[0];
    // eslint-disable-next-line no-await-in-loop
    if (!nudge) await wait(50);
  }
  assert(nudge?.type === 'engagement', `re-engagement push is typed 'engagement' (${nudge?.type})`);

  // ─────────────────────────────────────────────────────────────────
  console.log('\n[7] SMS STOP reaches a client whose phone was typed with formatting');
  const smsClient = (await sql`INSERT INTO clients (workspace_id, name, email, phone, sms_consent_at, stage)
    VALUES (${A.ws}, 'Tex', ${`ua-tex-${S}@example.com`}, '(555) 010-4477', NOW(), 'active') RETURNING id`).rows[0].id;
  const params = { From: '+15550104477', Body: 'STOP' };
  const url = 'https://localhost:3000/api/sms/inbound';
  const sorted = Object.keys(params).sort().map((k) => k + params[k]).join('');
  const sig = crypto.createHmac('sha1', process.env.IVY_TWILIO_AUTH_TOKEN).update(url + sorted).digest('base64');
  res = mkRes();
  await smsInbound({ method: 'POST', url: '/api/sms/inbound', body: new URLSearchParams(params).toString(),
    headers: { host: 'localhost:3000', 'x-forwarded-proto': 'https', 'x-twilio-signature': sig } }, res);
  const smsRow = (await sql`SELECT sms_consent_at FROM clients WHERE id = ${smsClient}`).rows[0];
  assert(res.statusCode === 200 && smsRow.sms_consent_at === null, `STOP cleared consent (${res.statusCode})`);

  // ─────────────────────────────────────────────────────────────────
  for (const w of created.workspaces) await sql`DELETE FROM workspaces WHERE id = ${w}`;
  for (const u of created.users) await sql`DELETE FROM users WHERE id = ${u}`;
  await sql`DELETE FROM waitlist_signups WHERE LOWER(email) = ${wl}`;
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
