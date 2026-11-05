// Email consent at sign-up and after.
//
//   [1] owner sign-up with both boxes: account-email consent + marketing
//       consent stored with timestamps, proof rows in legal_acceptances
//   [2] sign-up without the marketing box: marketing stays NULL
//   [3] acceptedAccountEmails sent as false (or junk) is refused, no account
//   [4] old app shape (no consent fields at all, iPhone 1.0.4) still works:
//       account made, consent recorded as NULL, welcome emails still go out
//   [5] client sign-up records the same
//   [6] helper invite acceptance: refuses false, records consent + source
//   [7] settings switch: GET shows state, PATCH off withdraws (audit row),
//       PATCH on re-grants from 'settings', bad value refused, same-origin
//   [8] one-click unsubscribe from a marketing email withdraws consent;
//       "unsubscribe from all" too; muting the category in older settings too
//
// Run: node --import ./tests/bootstrap.mjs ./tests/email-consent.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import { mintUnsubscribeToken } from '../api/_lib/unsubscribeToken.js';
import signupHandler from '../api/auth/signup.js';
import staffInvite from '../api/staff/[id]/invite.js';
import helperAccept from '../api/helper/accept.js';
import prefsHandler from '../api/me/notification-prefs.js';
import notificationsHandler from '../api/me/notifications.js';
import unsubscribeHandler from '../api/unsubscribe.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const emails = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('resend.com')) {
    emails.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ id: `em_${emails.length}` }), text: async () => '{}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};

const TAG = `consent${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const em = (t) => `${t}-${TAG}@example.com`;
let ipN = 0;
const nextIp = () => `198.51.100.${(++ipN % 200) + 20}`;

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else this.headers[key] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(o) { this.body = o; return this; },
    end(s) { if (s !== undefined) this.body = s; return this; },
  };
}
function mkReq({ method = 'POST', body = {}, query = {}, cookie, origin = 'http://localhost:3000' } = {}) {
  return {
    method, url: '/test', query, body,
    headers: {
      'content-type': 'application/json', host: 'localhost:3000', 'x-forwarded-for': nextIp(),
      ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}),
    },
  };
}
const call = async (h, opts) => { const r = mkRes(); await h(mkReq(opts), r); return r; };
const cookieFor = (id) => `ivy_session=${signSession(id)}`;
const PW = 'sufficiently-long-pass-123';
const base = (email, extra = {}) => ({
  email, name: 'Casey Consent', password: PW,
  acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION, ...extra,
});
const userRow = async (email) => (await sql`
  SELECT id, account_email_consent_at, marketing_consent_at, marketing_consent_source,
         marketing_consent_withdrawn_at, notification_prefs
    FROM users WHERE LOWER(email) = ${email.toLowerCase()} AND deleted_at IS NULL`).rows[0];
const proofs = async (id) => (await sql`SELECT document, version FROM legal_acceptances WHERE user_id = ${id}`).rows.map((r) => r.document);
const audits = async (id, action) => (await sql`SELECT * FROM audit_events WHERE target_user_id = ${id} AND action = ${action}`).rows;

async function cleanup() {
  const { rows } = await sql.query(`SELECT id FROM users WHERE email LIKE $1`, [`%${TAG}%`]);
  for (const r of rows) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${r.id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${r.id}`.catch(() => {});
  }
}

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] owner sign-up, both boxes ticked');
  let r = await call(signupHandler, { body: base(em('both'), { acceptedAccountEmails: true, marketingOptIn: true }) });
  assert(r.statusCode === 201, `signup 201 (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  let u = await userRow(em('both'));
  assert(!!u?.account_email_consent_at, 'account-email consent timestamp stored');
  assert(!!u?.marketing_consent_at && u.marketing_consent_source === 'signup', 'marketing consent stored with source signup');
  let docs = await proofs(u.id);
  assert(docs.includes('account_emails') && docs.includes('marketing_emails') && docs.includes('terms') && docs.includes('privacy'),
    'proof rows: terms, privacy, account_emails, marketing_emails');

  console.log('\n[2] marketing box left unticked');
  r = await call(signupHandler, { body: base(em('nomkt'), { acceptedAccountEmails: true, marketingOptIn: false }) });
  assert(r.statusCode === 201, 'signup 201');
  u = await userRow(em('nomkt'));
  assert(!!u.account_email_consent_at && u.marketing_consent_at === null && u.marketing_consent_source === null, 'marketing NULL, account consent set');
  docs = await proofs(u.id);
  assert(docs.includes('account_emails') && !docs.includes('marketing_emails'), 'no marketing proof row');

  console.log('\n[3] new shape with the required box false is refused');
  r = await call(signupHandler, { body: base(em('refused'), { acceptedAccountEmails: false, marketingOptIn: true }) });
  assert(r.statusCode === 400 && /emails about your account/i.test(r.body?.error || ''), `refused with a clear message (got ${r.statusCode})`);
  assert(!(await userRow(em('refused'))), 'no account created');
  r = await call(signupHandler, { body: base(em('junk'), { acceptedAccountEmails: 'yes' }) });
  assert(r.statusCode === 400 && !(await userRow(em('junk'))), 'non-boolean "yes" refused too');

  console.log('\n[4] old app shape (no consent fields) still signs up');
  const before = emails.length;
  r = await call(signupHandler, { body: base(em('oldapp')) });
  assert(r.statusCode === 201, `old shape 201 (got ${r.statusCode})`);
  u = await userRow(em('oldapp'));
  assert(u && u.account_email_consent_at === null && u.marketing_consent_at === null, 'consent recorded as NULL (not yet consented)');
  assert(!(await proofs(u.id)).includes('account_emails'), 'no account_emails proof row invented');
  assert(emails.length - before >= 2, 'verification + welcome emails still sent');

  console.log('\n[5] client sign-up');
  r = await call(signupHandler, { body: base(em('client'), { mode: 'client', acceptedAccountEmails: true, marketingOptIn: true }) });
  assert(r.statusCode === 201 && r.body?.role === 'client', 'client signup 201');
  u = await userRow(em('client'));
  assert(!!u.account_email_consent_at && !!u.marketing_consent_at, 'client consent stored');
  r = await call(signupHandler, { body: base(em('client2'), { mode: 'client', acceptedAccountEmails: false }) });
  assert(r.statusCode === 400 && !(await userRow(em('client2'))), 'client with required box false refused');

  console.log('\n[6] helper invite acceptance');
  const owner = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${em('owner')}, 'x', 'Helper Boss', NOW()) RETURNING id`).rows[0];
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${owner.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0];
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${ws.id}, 'Consent Studio', ${`consent-${TAG}`})`;
  const staffId = (await sql`INSERT INTO staff_members (workspace_id, name, email, active, owner_managed)
    VALUES (${ws.id}, 'Hana Helper', ${em('helper')}, TRUE, TRUE) RETURNING id`).rows[0].id;
  r = await call(staffInvite, { cookie: cookieFor(owner.id), query: { id: staffId } });
  assert(r.statusCode === 200, `invite sent (got ${r.statusCode})`);
  const tok = (emails[emails.length - 1]?.html || '').match(/\/helper\/invite\/([A-Za-z0-9_-]+)/)?.[1];
  const helperBody = { token: tok, name: 'Hana Helper', password: PW, acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION };
  r = await call(helperAccept, { body: { ...helperBody, acceptedAccountEmails: false } });
  assert(r.statusCode === 400 && !(await userRow(em('helper'))), 'helper with required box false refused, no sign-in made');
  r = await call(helperAccept, { body: { ...helperBody, acceptedAccountEmails: true, marketingOptIn: true } });
  assert(r.statusCode === 200 && r.body?.created === true, `helper sign-in created (got ${r.statusCode} ${JSON.stringify(r.body)})`);
  u = await userRow(em('helper'));
  assert(!!u.account_email_consent_at && u.marketing_consent_source === 'helper_invite', 'helper consent stored with source helper_invite');

  console.log('\n[7] settings switch');
  const nomkt = await userRow(em('nomkt'));
  const ck = cookieFor(nomkt.id);
  r = await call(prefsHandler, { method: 'GET', cookie: ck });
  assert(r.statusCode === 200 && r.body?.prefs?.marketingEmails === false, 'GET shows marketing off');
  r = await call(prefsHandler, { method: 'PATCH', cookie: ck, body: { marketingEmails: 'yes' } });
  assert(r.statusCode === 400, 'non-boolean refused');
  r = await call(prefsHandler, { method: 'PATCH', cookie: ck, body: { marketingEmails: true }, origin: 'https://evil.example' });
  assert(r.statusCode === 403, 'cross-origin PATCH refused');
  r = await call(prefsHandler, { method: 'PATCH', cookie: ck, body: { marketingEmails: true } });
  assert(r.statusCode === 200 && r.body?.prefs?.marketingEmails === true && r.body.prefs.marketingConsentSource === 'settings', 'turned on from settings');
  assert((await audits(nomkt.id, 'marketing_consent.grant')).length === 1, 'grant written to the audit log');
  r = await call(prefsHandler, { method: 'PATCH', cookie: ck, body: { marketingEmails: true } });
  assert((await audits(nomkt.id, 'marketing_consent.grant')).length === 1, 'turning on again changes nothing');
  r = await call(prefsHandler, { method: 'PATCH', cookie: ck, body: { marketingEmails: false } });
  u = await userRow(em('nomkt'));
  assert(r.body?.prefs?.marketingEmails === false && u.marketing_consent_at === null && !!u.marketing_consent_withdrawn_at, 'turned off: consent cleared, withdrawal stamped');
  assert(u.notification_prefs?.email_marketing === false, 'marketing category muted too');
  assert((await audits(nomkt.id, 'marketing_consent.withdraw')).length === 1, 'withdrawal audited');
  r = await call(prefsHandler, { method: 'PATCH', cookie: ck, body: { marketingEmails: true } });
  u = await userRow(em('nomkt'));
  assert(!!u.marketing_consent_at && u.notification_prefs?.email_marketing !== false, 'turning back on lifts the earlier mute');
  r = await call(prefsHandler, { method: 'PATCH', cookie: ck, body: { digestGroupsDaily: false } });
  assert(r.statusCode === 200 && r.body?.prefs?.digestGroupsDaily === false && r.body.prefs.marketingEmails === true, 'digest switch still works alongside');

  console.log('\n[8] unsubscribe withdraws consent');
  const both = await userRow(em('both'));
  let res = mkRes();
  await unsubscribeHandler({ method: 'POST', query: { token: mintUnsubscribeToken({ scope: 'user', id: both.id, type: 'marketing' }) }, headers: {} }, res);
  u = await userRow(em('both'));
  assert(res.statusCode === 200 && u.marketing_consent_at === null && u.notification_prefs?.email_marketing === false, 'one-click marketing unsubscribe clears consent');
  const client = await userRow(em('client'));
  res = mkRes();
  await unsubscribeHandler({ method: 'GET', query: { token: mintUnsubscribeToken({ scope: 'user', id: client.id, type: 'all' }) }, headers: {} }, res);
  u = await userRow(em('client'));
  assert(res.statusCode === 200 && u.marketing_consent_at === null, '"unsubscribe from all" clears consent');
  res = mkRes();
  await unsubscribeHandler({ method: 'POST', query: { token: mintUnsubscribeToken({ scope: 'user', id: nomkt.id, type: 'bookings' }) }, headers: {} }, res);
  assert(!!(await userRow(em('nomkt'))).marketing_consent_at, 'unsubscribing from another category leaves marketing consent alone');
  r = await call(notificationsHandler, { method: 'PATCH', cookie: ck, body: { emailPrefs: { marketing: false } } });
  assert(r.statusCode === 200 && (await userRow(em('nomkt'))).marketing_consent_at === null, 'muting marketing in the older settings switch withdraws too');
}

run()
  .catch((e) => { fail++; console.error('crashed:', e); })
  .finally(async () => {
    await cleanup().catch(() => {});
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
