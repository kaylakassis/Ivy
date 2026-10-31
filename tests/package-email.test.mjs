// The buyer's confirmation email when a package is provisioned from the
// paid Checkout webhook.
//
//   [1] one email per purchase: branding, package name, sessions included,
//       what it cost, expiry date, the booking link and the portal link;
//       the webhook replay and the async settle send nothing more; an
//       unpaid session sends nothing
//   [2] a buyer without a portal account gets the claim-your-portal line
//   [3] a template without expiry says so
//   [4] a muted client is provisioned but not emailed; copy rules
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/package-email.test.mjs
import crypto from 'node:crypto';
process.env.STRIPE_SECRET_KEY = 'sk_test_pkgmail';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_pkgmail';
process.env.APP_URL = 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import platformWebhook from '../api/webhooks/stripe-platform.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const emails = [];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.resend\.com/.test(u)) {
    try { emails.push(JSON.parse(String(init.body))); } catch { emails.push({}); }
    return json({ id: `em_${emails.length}` });
  }
  return json({});
};
const toList = (e) => (Array.isArray(e?.to) ? e.to : [e?.to]);
const mailsTo = (email) => emails.filter((e) => toList(e).includes(email));
const visible = (s) => String(s || '').replace(/<!--[\s\S]*?-->/g, '');
const noVendor = (s) => !/stripe|square|paypal|resend|business os/i.test(visible(s));
const noEmDash = (s) => !/—/.test(visible(s));

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
let evtN = 0;
async function fire(type, object, acct, eventId = null) {
  const payload = JSON.stringify({ id: eventId || `evt_pm_${Date.now()}_${++evtN}`, type, account: acct, data: { object } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  const res = mkRes();
  await platformWebhook({ method: 'POST', url: '/api/webhooks/stripe-platform', body: payload,
    headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' } }, res);
  return res;
}
const STAMP = Date.now();
const paidSession = ({ id, pi, wid, pkgId, clientId, amount, paid = true }) => ({
  id, mode: 'payment', payment_status: paid ? 'paid' : 'unpaid', status: 'complete', payment_intent: pi, amount_total: amount,
  metadata: { purpose: 'package', workspace_id: wid, package_id: pkgId, client_id: clientId },
});

async function run() {
  await ensureSchemaApplied();
  const owner = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`pm-owner-${STAMP}@example.com`}, 'x', 'Olive Owner', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${owner}, 'Glow Studio', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `pm-glow-${STAMP}`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, 'Glow Studio', ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}, biz_name = 'Glow Studio'`;
  const acct = `acct_pm_${STAMP}`;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status) VALUES (${wid}, ${acct}, 'complete')`;
  const pkg = (await sql`INSERT INTO packages (workspace_id, name, session_count, price, expiry_days) VALUES (${wid}, '5 Signature Cuts', 5, 180, 90) RETURNING id`).rows[0].id;
  const forever = (await sql`INSERT INTO packages (workspace_id, name, session_count, price, expiry_days) VALUES (${wid}, 'Single Session', 1, 60, NULL) RETURNING id`).rows[0].id;

  // A client who already has a portal account, and one who does not.
  const claimedEmail = `pm-claimed-${STAMP}@example.com`;
  const portalUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${claimedEmail}, 'x', 'Casey Client', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const claimed = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id) VALUES (${wid}, 'Casey Client', ${claimedEmail}, 'active', ${portalUser}) RETURNING id`).rows[0].id;
  const newEmail = `pm-new-${STAMP}@example.com`;
  const newbie = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Nina New', ${newEmail}, 'lead') RETURNING id`).rows[0].id;

  console.log('\n[1] one confirmation per purchase, with the right numbers');
  emails.length = 0;
  let r = await fire('checkout.session.completed', paidSession({ id: `cs_pm_unpaid_${STAMP}`, pi: `pi_pm_unpaid_${STAMP}`, wid, pkgId: pkg, clientId: claimed, amount: 18000, paid: false }), acct);
  assert(/awaiting settlement/.test(r.body.ignored || '') && mailsTo(claimedEmail).length === 0, 'unpaid session: nothing provisioned, nothing sent');
  const sess = paidSession({ id: `cs_pm_1_${STAMP}`, pi: `pi_pm_1_${STAMP}`, wid, pkgId: pkg, clientId: claimed, amount: 18000 });
  r = await fire('checkout.session.completed', sess, acct, `evt_pm_paid_${STAMP}`);
  assert(r.body.applied === 'package-provisioned', `paid session provisions (${JSON.stringify(r.body)})`);
  let mails = mailsTo(claimedEmail);
  assert(mails.length === 1, `buyer got exactly one email (${mails.length})`);
  const m = mails[0];
  assert(m.subject === 'Receipt: 5 Signature Cuts · $180.00', `subject is a receipt with the name and price (${m.subject})`);
  assert(/Glow Studio/.test(m.html) && /Hi Casey/.test(m.html), 'business branding and the buyer\'s first name');
  assert(/5 Signature Cuts/.test(m.html) && /5 sessions/.test(m.html) && /\$180\.00/.test(m.html), 'package name, sessions included, what it cost');
  const cp = (await sql`SELECT expires_at FROM client_packages WHERE stripe_session_id = ${sess.id}`).rows[0];
  const expiryLabel = new Date(cp.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  assert(m.html.includes(expiryLabel), `expiry date spelled out (${expiryLabel})`);
  assert(m.html.includes(`https://www.joinivy.ai/book/${slug}`), 'link to the booking page');
  assert(m.html.includes('https://www.joinivy.ai/me') && !/Claim your portal account/.test(m.html), 'claimed client: portal link, no claim line');
  assert(/How to book/.test(m.html) && /This email is your receipt/.test(m.html), 'how to book + receipt line');
  assert(m.reply_to === `pm-owner-${STAMP}@example.com`, `reply-to routes to the owner (${m.reply_to})`);
  r = await fire('checkout.session.completed', sess, acct, `evt_pm_paid_${STAMP}`);
  assert(r.body.deduped === true, 'same event id deduped');
  r = await fire('checkout.session.completed', sess, acct);
  assert(r.body.ignored === 'package already provisioned', 'replay with a new event id is a no-op');
  r = await fire('checkout.session.async_payment_succeeded', sess, acct);
  assert(r.body.ignored === 'package already provisioned', 'async settle after a paid completion is a no-op');
  assert(mailsTo(claimedEmail).length === 1, 'still exactly one email after the replays');

  console.log('\n[2] a buyer without a portal account is invited to claim it');
  r = await fire('checkout.session.completed', paidSession({ id: `cs_pm_2_${STAMP}`, pi: `pi_pm_2_${STAMP}`, wid, pkgId: pkg, clientId: newbie, amount: 18000 }), acct);
  assert(r.body.applied === 'package-provisioned', 'second buyer provisioned');
  mails = mailsTo(newEmail);
  assert(mails.length === 1 && /Hi Nina/.test(mails[0].html), 'one email to the new buyer');
  assert(/Claim your portal account/.test(mails[0].html) && mails[0].html.includes(`/signup?mode=client&amp;email=${encodeURIComponent(newEmail)}`), 'claim line with the signup link, email prefilled');
  assert(!mails[0].html.includes('https://www.joinivy.ai/me<') && !/portal at <a/.test(mails[0].html), 'no "open your portal" line for an unclaimed client');

  console.log('\n[3] a template without expiry');
  r = await fire('checkout.session.completed', paidSession({ id: `cs_pm_3_${STAMP}`, pi: `pi_pm_3_${STAMP}`, wid, pkgId: forever, clientId: claimed, amount: 6000 }), acct);
  mails = mailsTo(claimedEmail);
  assert(mails.length === 2 && /No expiry/.test(mails[1].html) && /1 session</.test(mails[1].html) && /\$60\.00/.test(mails[1].html), 'no expiry, singular session, right price');

  console.log('\n[4] muted client; copy rules');
  await sql`UPDATE clients SET notification_prefs = '{"invoices": false}'::jsonb WHERE id = ${newbie}`;
  r = await fire('checkout.session.completed', paidSession({ id: `cs_pm_4_${STAMP}`, pi: `pi_pm_4_${STAMP}`, wid, pkgId: forever, clientId: newbie, amount: 6000 }), acct);
  assert(r.body.applied === 'package-provisioned' && mailsTo(newEmail).length === 1, 'muted client: provisioned, no email');
  assert((await sql`SELECT COUNT(*)::int AS n FROM client_packages WHERE workspace_id = ${wid}`).rows[0].n === 4, 'four bundles provisioned in all');
  const everything = emails.map((e) => e.subject + e.html).join('\n');
  assert(noVendor(everything) && noEmDash(everything), 'no vendor names, no em dashes, never "business OS"');
  assert(!/<script/i.test(everything), 'no scripts');

  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id IN (${owner}, ${portalUser})`;
}

run().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((err) => {
  console.error('Fatal:', err.message, err.stack);
  process.exit(1);
});
