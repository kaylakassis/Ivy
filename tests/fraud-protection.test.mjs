// Fraud protection (1.0.7):
//   [1] sign-up hardening: throwaway inboxes refused for businesses, the
//       person check (hidden field + signed page-open time), the country
//       a sign-up came from is recorded
//   [2] a confirmed email is required before connecting Stripe
//   [3] a risk hold takes the business offline everywhere and nothing but
//       an admin lifts it
//   [4] Stripe rejecting an account places a hold and emails the operator;
//       a review is flagged, unfinished paperwork is neither
//   [5] failed card payments are counted once each and flag the business
//   [6] Admin > Risk: the list, hold / release / looks fine, admins only
//
// Run: node --import ./tests/bootstrap.mjs ./tests/fraud-protection.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_fraud';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fraud';
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.SUPER_ADMIN_EMAIL = `fraud-ops-${Date.now()}@example.com`;

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { isDisposableEmail, DISPOSABLE_EMAIL_DOMAINS } from '../api/_lib/disposableEmail.js';
import { checkHuman, issueFormToken, HONEYPOT_FIELD } from '../api/_lib/humanCheck.js';
import {
  placeRiskHold, releaseRiskHold, isOnRiskHold, applyStripeAccountStatus, listRiskAccounts,
  syncStripeAccountStatuses, stripeReasonLabel, recordRiskEvent,
} from '../api/_lib/riskHold.js';
import { isWorkspaceActive, userContext } from '../api/_lib/clientPortal.js';
import { ensureActiveWorkspace, evictWorkspaceGateCache } from '../api/_lib/workspaceGate.js';
import { loadWorkspaceAccess } from '../api/_lib/businessAccess.js';
import { chargeInvoiceAutopay } from '../api/_lib/autopay.js';
import signupHandler from '../api/auth/signup.js';
import statusHandler from '../api/early-access/status.js';
import stripeInit from '../api/finance/stripe-oauth-init.js';
import billingCheckout from '../api/billing/checkout.js';
import publicBooking from '../api/calendar/public/[slug].js';
import payHandler from '../api/invoice-pay/[token].js';
import platformWebhook from '../api/webhooks/stripe-platform.js';
import riskHandler from '../api/admin/risk.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const HOST = 'www.joinivy.ai';
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// Stripe and the email service, faked: what Stripe says about each account
// is whatever `accounts[acct]` holds.
const emails = [];
const accounts = {};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.resend\.com/.test(u)) { try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); } return json({ id: `em_${emails.length}` }); }
  if (/api\.stripe\.com\/v1\/account$/.test(u)) {
    const id = init.headers?.['Stripe-Account'];
    const a = accounts[id];
    if (!a) return json({ error: { message: 'No such account' } }, 404);
    return json({ id, charges_enabled: !a.reason, payouts_enabled: !a.reason, details_submitted: true, livemode: false, email: 'x@example.com', requirements: { disabled_reason: a.reason || null } });
  }
  return json({});
};

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(c, h = {}) { this.statusCode = c; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; return this; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
let ipN = 1;
const req = ({ method = 'GET', cookie, query = {}, body = {}, headers = {} } = {}) => ({
  method, url: '/t', query, body,
  headers: {
    'content-type': 'application/json', origin: `https://${HOST}`, host: HOST,
    'x-forwarded-for': `198.20.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`, 'user-agent': 'FraudKit',
    ...(cookie ? { cookie } : {}), ...headers,
  },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }
const cookieFor = async (userId) => `ivy_session=${signSession(userId)}`;

async function mkBiz(label, { verified = true, onboarded = true, userType = null, status = 'active', acct = true, daysOld = 0 } = {}) {
  const email = `fraud-${label}-${S}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${`Owner ${label}`}, ${verified ? new Date().toISOString() : null}, ${userType || 'regular'}, '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at, created_at)
    VALUES (${u}, ${`${label} Studio`}, ${status}, NOW() + INTERVAL '30 days', ${onboarded ? new Date().toISOString() : null}, NOW() - (${daysOld}::int * INTERVAL '1 day')) RETURNING id`).rows[0].id;
  const slug = `fraud-${label}-${S}`.toLowerCase();
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, ${`${label} Studio`}, ${slug})
            ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}, biz_name = ${`${label} Studio`}`;
  const acctId = acct ? `acct_fraud_${label}_${S}` : null;
  if (acct) {
    await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status, currency) VALUES (${wid}, ${acctId}, 'complete', 'USD')`;
    accounts[acctId] = { reason: null };
  }
  return { u, wid, slug, email, acctId, cookie: await cookieFor(u) };
}
const gate = async (biz) => {
  evictWorkspaceGateCache(biz.wid);
  const user = (await sql`SELECT * FROM users WHERE id = ${biz.u}`).rows[0];
  const res = mkRes();
  const out = await ensureActiveWorkspace(user, req(), res);
  return { out, res };
};
let evtN = 0;
async function fire(type, object, acct) {
  const payload = JSON.stringify({ id: `evt_fraud_${S}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload, headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}
const signupBody = (email, extra = {}) => ({
  email, password: 'Sup3r-long-passphrase!', name: 'Test Person', mode: 'owner',
  acceptedTermsVersion: extra.terms, acceptedPrivacyVersion: extra.privacy, acceptedAccountEmails: true, ...extra.fields,
});

async function run() {
  await ensureSchemaApplied();
  const { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } = await import('../src/lib/legal.js');
  const legal = { terms: CURRENT_TERMS_VERSION, privacy: CURRENT_PRIVACY_VERSION };
  await sql`DELETE FROM rate_limits WHERE key LIKE 'signup:%'`;

  console.log('\n[1] sign-up hardening');
  assert(isDisposableEmail('x@mailinator.com') && isDisposableEmail('x@sub.yopmail.com') && isDisposableEmail('X@GuerrillaMail.com'), 'throwaway inboxes are recognised (any capitals, subdomains too)');
  assert(['gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'proton.me', 'hotmail.com', 'aol.com', 'market-theory.com'].every((d) => !isDisposableEmail(`a@${d}`)), 'ordinary mail providers are never treated as throwaway');
  assert(new Set(DISPOSABLE_EMAIL_DOMAINS).size === DISPOSABLE_EMAIL_DOMAINS.length && DISPOSABLE_EMAIL_DOMAINS.length > 100, 'the list has no duplicates');
  let r = await call(signupHandler, req({ method: 'POST', body: signupBody(`fraud-burner-${S}@mailinator.com`, legal) }));
  assert(r.statusCode === 400 && r.body.details?.code === 'disposable_email' && /email address you will keep/.test(r.body.error), `a business sign-up with a throwaway inbox is refused in plain words (${r.statusCode})`);
  assert((await sql`SELECT 1 FROM users WHERE email = ${`fraud-burner-${S}@mailinator.com`}`).rows.length === 0, '...and no account is created');
  r = await call(signupHandler, req({ method: 'POST', body: { ...signupBody(`fraud-client-${S}@mailinator.com`, legal), mode: 'client' } }));
  assert(r.statusCode === 200 || r.statusCode === 201, `a client (a business's own customer) is not blocked by that rule (${r.statusCode})`);
  r = await call(signupHandler, req({ method: 'POST', headers: { 'x-vercel-ip-country': 'NG' }, body: signupBody(`fraud-abroad-${S}@example.com`, legal) }));
  const abroad = (await sql`SELECT u.id, u.signup_country, w.id AS wid FROM users u JOIN workspaces w ON w.owner_id = u.id WHERE u.email = ${`fraud-abroad-${S}@example.com`}`).rows[0];
  assert((r.statusCode === 200 || r.statusCode === 201) && abroad?.signup_country === 'NG', `the country a sign-up came from is recorded (${abroad?.signup_country})`);
  r = await call(signupHandler, req({ method: 'POST', headers: { 'x-vercel-ip-country': 'not-a-country' }, body: signupBody(`fraud-nocountry-${S}@example.com`, legal) }));
  assert((await sql`SELECT signup_country FROM users WHERE email = ${`fraud-nocountry-${S}@example.com`}`).rows[0]?.signup_country === null, 'a malformed country header is ignored');

  // The person check, on (the general suites run with it off).
  process.env.SIGNUP_HUMAN_CHECK = 'on';
  const now = Date.now();
  const tok = issueFormToken(now - 5000);
  assert(checkHuman(req(), { formToken: tok }, now).ok === true, 'a token from a page opened 5 seconds ago passes');
  assert(checkHuman(req(), { formToken: issueFormToken(now - 500) }, now).code === 'human_check_fast', 'a sign-up half a second after the page opened is refused as too fast');
  assert(checkHuman(req(), { formToken: issueFormToken(now - 3 * 3600e3) }, now).ok === false, 'a token from three hours ago has expired');
  assert(checkHuman(req(), { formToken: `${now - 5000}.${'0'.repeat(32)}` }, now).ok === false && checkHuman(req(), { formToken: 'garbage' }, now).ok === false, 'a forged or malformed token is refused');
  assert(checkHuman(req(), { formToken: tok, [HONEYPOT_FIELD]: 'http://spam.example' }, now).ok === false, 'the hidden field filled in gives a script away, even with a good token');
  assert(checkHuman(req(), {}, now).ok === false, 'a web sign-up with no token is refused');
  assert(checkHuman(req({ headers: { 'x-client-platform': 'ios', origin: 'capacitor://localhost' } }), {}, now).ok === true, 'the iPhone app builds that predate the token still get through');
  assert(checkHuman(req({ headers: { 'x-client-platform': 'ios', origin: 'https://evil.example' } }), {}, now).ok === false, '...but claiming to be the app from a web page does not');
  r = await call(statusHandler, req());
  assert(typeof r.body.formToken === 'string' && /^\d+\.[0-9a-f]{32}$/.test(r.body.formToken) && /no-store/.test(r.headers['cache-control'] || ''), 'the public status endpoint hands the form its token and is never cached');
  r = await call(signupHandler, req({ method: 'POST', body: signupBody(`fraud-bot-${S}@example.com`, legal) }));
  assert(r.statusCode === 400 && r.body.details?.code === 'human_check', `sign-up endpoint refuses a tokenless web request (${r.statusCode})`);
  r = await call(signupHandler, req({ method: 'POST', body: signupBody(`fraud-bot-${S}@example.com`, { ...legal, fields: { formToken: r.body.formToken || issueFormToken(Date.now() - 100) } }) }));
  assert(r.statusCode === 400 && r.body.details?.code === 'human_check_fast', 'sign-up endpoint refuses an instant submit');
  r = await call(signupHandler, req({ method: 'POST', body: signupBody(`fraud-human-${S}@example.com`, { ...legal, fields: { formToken: issueFormToken(Date.now() - 4000), [HONEYPOT_FIELD]: '' } }) }));
  assert(r.statusCode === 200 || r.statusCode === 201, `a person who took four seconds signs up normally (${r.statusCode} ${r.body?.error || ''})`);
  assert((await sql`SELECT 1 FROM users WHERE email = ${`fraud-bot-${S}@example.com`}`).rows.length === 0, 'the refused attempts created no account');
  process.env.SIGNUP_HUMAN_CHECK = 'off';

  console.log('\n[2] a confirmed email is required before connecting Stripe');
  const unv = await mkBiz('unverified', { verified: false, acct: false });
  r = await call(stripeInit, req({ cookie: unv.cookie }));
  assert(r.statusCode === 302 && r.headers.location === '/finance?stripeError=verify_email', `unconfirmed email: sent back to Finance with the reason (${r.headers.location})`);
  r = await call(stripeInit, req({ cookie: unv.cookie, query: { from: 'onboarding' } }));
  assert(r.headers.location === '/onboarding?stripeError=verify_email', 'same during onboarding');
  r = await call(stripeInit, req({ cookie: unv.cookie, query: { mode: 'json' }, headers: { accept: 'application/json' } }));
  assert(r.statusCode === 400 && r.body.details?.code === 'verify_email' && r.body.error.includes(unv.email), 'the app gets a plain message naming the inbox to check');
  assert((await sql`SELECT 1 FROM finance_settings WHERE workspace_id = ${unv.wid} AND stripe_connect_user_id IS NOT NULL`).rows.length === 0, 'no Stripe account was created for them');
  const ver = await mkBiz('verified', { acct: false });
  r = await call(stripeInit, req({ cookie: ver.cookie }));
  assert(!/verify_email|on_hold/.test(r.headers.location || '') && r.statusCode === 302, `a confirmed owner gets past the check (${(r.headers.location || '').slice(0, 60)})`);

  console.log('\n[3] a risk hold takes the business offline everywhere');
  const biz = await mkBiz('held');
  const svc = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes) VALUES (${biz.wid}, 'Cut', 40, 30) RETURNING id`).rows[0].id;
  assert(!!svc && (await gate(biz)).out === biz.wid && (await loadWorkspaceAccess(biz.wid)).active === true, 'before: the owner is in and the business is open');
  let h = await placeRiskHold({ workspaceId: biz.wid, reason: 'Looks like a fake business', source: 'admin', actor: 'ops@example.com' });
  assert(h.ok && h.placed === true && await isOnRiskHold(biz.wid), 'hold placed');
  h = await placeRiskHold({ workspaceId: biz.wid, reason: 'second reason', source: 'stripe' });
  const row = (await sql`SELECT * FROM workspaces WHERE id = ${biz.wid}`).rows[0];
  assert(h.ok && h.placed === false && row.risk_hold_reason === 'Looks like a fake business' && row.risk_hold_source === 'admin', 'placing it twice keeps the first reason and source');
  assert(row.subscription_status === 'active', 'the subscription state is left alone (billing webhooks cannot lift a hold)');
  let g = await gate(biz);
  assert(g.out === null && g.res.statusCode === 402 && g.res.body.error === 'account-on-hold' && g.res.body.code === 'account_on_hold' && /on hold/.test(g.res.body.message), 'owner app: locked with a plain "on hold" answer');
  assert(isWorkspaceActive(row) === false && isWorkspaceActive({ ...row, comp_until: new Date(Date.now() + 864e5).toISOString() }) === false, 'the hold beats an active plan and complimentary access');
  const { risk_hold_at: _omit, ...withoutHold } = row;
  assert(isWorkspaceActive(withoutHold) === true, 'the data-deletion sweep, which does not read the hold, still sees an active business (a held business is never purged)');
  const acc = await loadWorkspaceAccess(biz.wid);
  assert(acc.active === false, 'public gate: not active');
  r = await call(publicBooking, req({ query: { slug: biz.slug } }));
  assert(r.statusCode === 200 && r.body.archived === true && !r.body.services, 'booking page shows the "no longer available" card, no services');
  r = await call(publicBooking, req({ method: 'POST', query: { slug: biz.slug }, body: { serviceId: svc, date: '2030-01-07', startMin: 600, name: 'A', email: 'a@example.com' } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'booking (and its deposit) is refused');
  const tokenRaw = crypto.randomBytes(24).toString('hex');
  const inv = (await sql`INSERT INTO invoices (workspace_id, client_name, client_email, number, status, items, total, view_token_hash)
    VALUES (${biz.wid}, 'Pat', 'pat@example.com', ${`F-${S}`}, 'sent', '[{"description":"x","quantity":1,"rate":20}]'::jsonb, 20, ${crypto.createHash('sha256').update(tokenRaw).digest('hex')}) RETURNING id`).rows[0].id;
  r = await call(payHandler, req({ method: 'POST', query: { token: tokenRaw } }));
  assert(r.statusCode === 403 && /not taking payments/.test(r.body.error), 'an invoice pay link is refused');
  const ap = await chargeInvoiceAutopay({ workspaceId: biz.wid, invoiceId: inv });
  assert(ap.outcome === 'not_open' || ap.outcome === 'on_hold' || ap.outcome === 'no_consent', `automatic charges do not run (${ap.outcome})`);
  r = await call(stripeInit, req({ cookie: biz.cookie }));
  assert(r.statusCode === 402 && r.body?.error === 'account-on-hold' && (await sql`SELECT stripe_connect_user_id FROM finance_settings WHERE workspace_id = ${biz.wid}`).rows[0].stripe_connect_user_id === biz.acctId, 'cannot start or resume a Stripe connection');
  r = await call(billingCheckout, req({ method: 'POST', cookie: biz.cookie, body: { plan: 'monthly' } }));
  assert(r.statusCode === 403 && r.body.code === 'account_on_hold' || r.statusCode === 400, `no subscription is sold to a held account (${r.statusCode})`);
  const ctx = await userContext((await sql`SELECT * FROM users WHERE id = ${biz.u}`).rows[0]);
  assert(ctx.subscription?.onHold === true && ctx.subscription?.isActive === false, 'the app is told the account is on hold (it shows the on-hold screen, not the paywall)');
  // Not finished onboarding, and platform-comped: neither is a way round it.
  const fresh = await mkBiz('fresh', { onboarded: false, status: 'incomplete' });
  assert((await gate(fresh)).out === fresh.wid, 'an owner still onboarding is normally let in');
  await placeRiskHold({ workspaceId: fresh.wid, reason: 'x', source: 'admin' });
  assert((await gate(fresh)).out === null, '...but not when on hold');
  const spons = await mkBiz('sponsored', { userType: 'sponsored', status: 'inactive' });
  assert((await gate(spons)).out === spons.wid, 'a sponsored account is normally let in');
  await placeRiskHold({ workspaceId: spons.wid, reason: 'x', source: 'admin' });
  g = await gate(spons);
  assert(g.out === null && g.res.body.error === 'account-on-hold', '...but not when on hold');
  const sctx = await userContext((await sql`SELECT * FROM users WHERE id = ${spons.u}`).rows[0]);
  assert(sctx.subscription?.isActive === false && sctx.subscription?.onHold === true, '...and the app is not told it is active');
  const adminBiz = await mkBiz('admin', { userType: 'super_admin' });
  h = await placeRiskHold({ workspaceId: adminBiz.wid, reason: 'x', source: 'stripe' });
  assert(h.ok === false && h.reason === 'operator-account' && !(await isOnRiskHold(adminBiz.wid)), 'an operator account can never be put on hold');
  // Another business is untouched.
  const other = await mkBiz('other');
  assert((await gate(other)).out === other.wid && (await loadWorkspaceAccess(other.wid)).active === true, 'another business is unaffected');
  // Lifting it brings everything back.
  h = await releaseRiskHold({ workspaceId: biz.wid, actor: 'ops@example.com' });
  assert(h.released === true && (await gate(biz)).out === biz.wid && (await loadWorkspaceAccess(biz.wid)).active === true, 'lifting the hold brings the owner app and public pages back');
  r = await call(publicBooking, req({ query: { slug: biz.slug } }));
  assert(r.statusCode === 200 && !r.body.archived, 'booking page is back');
  assert((await sql`SELECT COUNT(*)::int n FROM services WHERE workspace_id = ${biz.wid}`).rows[0].n === 1, 'nothing was deleted');
  const kinds = (await sql`SELECT kind FROM risk_events WHERE workspace_id = ${biz.wid} ORDER BY created_at`).rows.map((x) => x.kind);
  assert(kinds.includes('hold_placed') && kinds.includes('hold_released'), 'placing and lifting are both on record');

  console.log('\n[4] Stripe rejecting an account');
  const rej = await mkBiz('rejected');
  emails.length = 0;
  accounts[rej.acctId] = { reason: 'rejected.fraud' };
  r = await fire('account.updated', { id: rej.acctId }, rej.acctId);
  await settle();
  const rejRow = (await sql`SELECT w.risk_hold_at, w.risk_hold_reason, w.risk_hold_source, fs.stripe_disabled_reason FROM workspaces w JOIN finance_settings fs ON fs.workspace_id = w.id WHERE w.id = ${rej.wid}`).rows[0];
  assert(r.statusCode === 200 && !!rejRow.risk_hold_at && rejRow.risk_hold_source === 'stripe' && rejRow.stripe_disabled_reason === 'rejected.fraud', 'the webhook takes the business offline');
  assert(rejRow.risk_hold_reason === 'Stripe rejected this account for suspected fraud', `the reason is in plain words (${rejRow.risk_hold_reason})`);
  const mail = emails.find((m) => /On hold: rejected Studio/.test(m.subject || ''));
  assert(!!mail && [].concat(mail.to).includes(process.env.SUPER_ADMIN_EMAIL) && /suspected fraud/.test(mail.html) && mail.html.includes(rej.email) && mail.html.includes('https://www.joinivy.ai/admin?tab=risk') && /joinivy\.ai\/admin\?tab=risk/.test(mail.text || '') && !/[–—]/.test(mail.html + mail.subject), 'the operator is emailed: which business, why, and a link to the risk list (no long dashes)');
  assert((await gate(rej)).out === null && (await loadWorkspaceAccess(rej.wid)).active === false, 'owner app locked, public pages off');
  emails.length = 0;
  await fire('account.updated', { id: rej.acctId }, rej.acctId);
  await settle();
  assert(emails.filter((m) => /On hold/.test(m.subject || '')).length === 0 && (await sql`SELECT COUNT(*)::int n FROM risk_events WHERE workspace_id = ${rej.wid} AND kind = 'stripe_rejected'`).rows[0].n === 1, 'a repeat of the same news does not email again or log it twice');
  const rev = await mkBiz('review');
  accounts[rev.acctId] = { reason: 'under_review' };
  await fire('account.updated', { id: rev.acctId }, rev.acctId);
  assert(!(await isOnRiskHold(rev.wid)) && (await sql`SELECT 1 FROM risk_events WHERE workspace_id = ${rev.wid} AND kind = 'stripe_restricted'`).rows.length === 1, 'a Stripe review is flagged, the business stays up');
  const paper = await mkBiz('paperwork');
  let st = await applyStripeAccountStatus({ workspaceId: paper.wid, accountId: paper.acctId, disabledReason: 'requirements.past_due' });
  assert(st.held === false && !(await isOnRiskHold(paper.wid)) && (await sql`SELECT 1 FROM risk_events WHERE workspace_id = ${paper.wid}`).rows.length === 0, 'unfinished identity paperwork is neither a hold nor a flag');
  st = await applyStripeAccountStatus({ workspaceId: paper.wid, accountId: paper.acctId, disabledReason: null });
  assert((await sql`SELECT stripe_disabled_reason FROM finance_settings WHERE workspace_id = ${paper.wid}`).rows[0].stripe_disabled_reason === null, 'the reason clears when Stripe clears it');
  assert(stripeReasonLabel('rejected.terms_of_service') === 'Stripe rejected this account for breaking its terms' && stripeReasonLabel(null) === null, 'reasons are worded plainly');
  // The sweep catches a rejection whose webhook never arrived.
  const missed = await mkBiz('missed');
  accounts[missed.acctId] = { reason: 'rejected.other' };
  const sweep = await syncStripeAccountStatuses({ limit: 1000, deadlineMs: 20000 });
  assert(sweep.ok && sweep.checked >= 1 && await isOnRiskHold(missed.wid), `"Check Stripe now" finds a rejection the webhook missed (${sweep.checked} checked, ${sweep.held} held)`);
  assert(!(await isOnRiskHold(other.wid)) && !(await isOnRiskHold(ver.wid)), 'healthy accounts are left alone by the sweep');

  console.log('\n[5] failed card payments');
  const tester = await mkBiz('tester');
  for (let i = 1; i <= 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    await fire('charge.failed', { id: `ch_${S}_${i}`, amount: 2000, currency: 'usd', outcome: { type: i === 1 ? 'issuer_declined' : 'blocked', reason: 'highest_risk_level' } }, tester.acctId);
    // The same attempt also arrives as a payment-intent event: counted once.
    // eslint-disable-next-line no-await-in-loop
    await fire('payment_intent.payment_failed', { id: `pi_${S}_${i}`, amount: 2000, currency: 'usd', latest_charge: `ch_${S}_${i}`, last_payment_error: { code: 'card_declined' } }, tester.acctId);
  }
  const evs = (await sql`SELECT kind, detail FROM risk_events WHERE workspace_id = ${tester.wid}`).rows;
  assert(evs.length === 3 && evs.filter((e) => e.kind === 'payment_blocked').length === 2 && evs.every((e) => e.detail.amount_cents === 2000), `three failed attempts are three events, however Stripe reports them (${evs.length})`);

  console.log('\n[6] Admin > Risk');
  let list = await listRiskAccounts({ limit: 500 });
  const find = (b) => list.find((a) => a.workspaceId === b.wid);
  assert(find(rej)?.held === true && find(missed)?.held === true && find(rej).holdSource === 'stripe', 'businesses on hold are listed');
  assert(find(tester)?.flags.some((f) => f.id === 'failed_payments' && /3 failed or blocked card payments/.test(f.label)), 'three failed payments in a day flags the business');
  assert(find(rev)?.flags.some((f) => f.id === 'stripe' && /reviewing/.test(f.label)) && !find(rev).held, 'a Stripe review is listed, not held');
  assert(list.find((a) => a.workspaceId === abroad.wid)?.flags.some((f) => f.id === 'outside_us' && /NG/.test(f.label)), 'a sign-up from outside the US is flagged');
  const legacy = await mkBiz('legacy', { acct: false });
  await sql`UPDATE users SET email = ${`fraud-legacy-${S}@yopmail.com`} WHERE id = ${legacy.u}`;
  const unvStripe = await mkBiz('unvstripe', { verified: false });
  const oldUnv = await mkBiz('oldunv', { verified: false, daysOld: 200 });
  list = await listRiskAccounts({ limit: 500 });
  assert(find(legacy)?.flags.some((f) => f.id === 'throwaway_email'), 'an older account on a throwaway inbox is flagged');
  assert(find(unvStripe)?.flags.some((f) => f.id === 'unverified_email') && !find(oldUnv), 'recently connected Stripe without confirming email: flagged; a long-standing business is not');
  assert(!find(other) && !find(ver) && !find(paper) && !find(adminBiz), 'ordinary businesses, unfinished paperwork and operator accounts are not on the list');
  assert(list.every((a) => !('passwordHash' in a) && typeof a.email === 'string' && Array.isArray(a.flags)), 'rows carry only what the operator needs');

  const stranger = await mkBiz('stranger');
  r = await call(riskHandler, req({ cookie: stranger.cookie }));
  assert(r.statusCode === 403 || r.statusCode === 401, `a normal owner cannot open the risk list (${r.statusCode})`);
  r = await call(riskHandler, req({ method: 'POST', cookie: stranger.cookie, body: { action: 'hold', workspaceId: other.wid, reason: 'grudge' } }));
  assert((r.statusCode === 403 || r.statusCode === 401) && !(await isOnRiskHold(other.wid)), 'nor put a rival on hold');
  r = await call(riskHandler, req({}));
  assert(r.statusCode === 401, 'signed out: refused');
  const ops = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type, terms_version, terms_accepted_at)
    VALUES (${process.env.SUPER_ADMIN_EMAIL}, 'x', 'Ops', NOW(), 'super_admin', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const opsCookie = await cookieFor(ops);
  r = await call(riskHandler, req({ cookie: opsCookie }));
  assert(r.statusCode === 200 && r.body.accounts.some((a) => a.workspaceId === rej.wid), 'the operator sees the list');
  r = await call(riskHandler, req({ method: 'POST', cookie: opsCookie, body: { action: 'hold', workspaceId: tester.wid, reason: '   ' } }));
  assert(r.statusCode === 400 && !(await isOnRiskHold(tester.wid)), 'taking a business offline needs a reason');
  r = await call(riskHandler, req({ method: 'POST', cookie: opsCookie, body: { action: 'hold', workspaceId: 'not-an-id', reason: 'x' } }));
  assert(r.statusCode === 400, 'a malformed id is refused');
  r = await call(riskHandler, req({ method: 'POST', cookie: opsCookie, body: { action: 'hold', workspaceId: tester.wid, reason: 'Testing stolen cards' } }));
  assert(r.statusCode === 200 && r.body.placed === true && await isOnRiskHold(tester.wid) && r.body.accounts.find((a) => a.workspaceId === tester.wid)?.holdReason === 'Testing stolen cards', 'one tap takes it offline and the list comes back updated');
  assert((await gate(tester)).out === null, '...and the owner is locked out');
  r = await call(riskHandler, req({ method: 'POST', cookie: opsCookie, body: { action: 'hold', workspaceId: adminBiz.wid, reason: 'x' } }));
  assert(r.statusCode === 400 && /admin account/.test(r.body.error), 'an admin account cannot be put on hold from the list either');
  r = await call(riskHandler, req({ method: 'POST', cookie: opsCookie, body: { action: 'release', workspaceId: tester.wid } }));
  assert(r.statusCode === 200 && r.body.released === true && !(await isOnRiskHold(tester.wid)) && (await gate(tester)).out === tester.wid, 'lifting the hold from the list works');
  r = await call(riskHandler, req({ method: 'POST', cookie: opsCookie, body: { action: 'reviewed', workspaceId: abroad.wid } }));
  assert(r.statusCode === 200 && !r.body.accounts.some((a) => a.workspaceId === abroad.wid), '"Looks fine" takes a flagged business off the list');
  await recordRiskEvent(abroad.wid, 'payment_failed', { stripe_id: 'a' });
  await recordRiskEvent(abroad.wid, 'payment_failed', { stripe_id: 'b' });
  await recordRiskEvent(abroad.wid, 'payment_blocked', { stripe_id: 'c' });
  list = await listRiskAccounts({ limit: 500 });
  assert(list.find((a) => a.workspaceId === abroad.wid)?.flags.some((f) => f.id === 'failed_payments'), '...until something new is flagged');
  accounts[ver.acctId || 'none'] = { reason: null };
  r = await call(riskHandler, req({ method: 'POST', cookie: opsCookie, body: { action: 'sync' } }));
  assert(r.statusCode === 200 && r.body.ok === true && typeof r.body.checked === 'number' && Array.isArray(r.body.accounts), `"Check Stripe now" reports what it did (${r.body.checked} checked)`);
  const audit = (await sql`SELECT action FROM audit_events WHERE actor_user_id = ${ops}`).rows.map((x) => x.action);
  assert(['risk.hold', 'risk.release', 'risk.reviewed', 'risk.sync'].every((a) => audit.includes(a)), 'every action is in the audit log with who did it');
  r = await call(riskHandler, req({ method: 'POST', cookie: opsCookie, body: { action: 'nuke', workspaceId: tester.wid } }));
  assert(r.statusCode === 400, 'an unknown action is refused');

}

// Lift the holds this run placed (even when an assertion threw) so later
// suites and the local risk list see a clean database.
async function cleanup() {
  await sql`UPDATE workspaces SET risk_hold_at = NULL, risk_hold_reason = NULL, risk_hold_source = NULL
             WHERE id IN (SELECT w.id FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE u.email LIKE ${`fraud-%-${S}@%`})`.catch(() => {});
  // ...and remove this run's test accounts, so the local risk list stays readable.
  await sql`DELETE FROM users WHERE email LIKE ${`fraud-%-${S}@%`} OR email = ${process.env.SUPER_ADMIN_EMAIL}`.catch(() => {});
}

run().finally(cleanup).then(() => {
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
