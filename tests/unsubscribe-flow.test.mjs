// Unsubscribing actually stops the email. Mints real footer tokens, hits the
// public /api/unsubscribe handler, then proves the next send is muted.
// Run: node --import ./tests/bootstrap.mjs ./tests/unsubscribe-flow.test.mjs
process.env.RESEND_API_KEY ||= 're_test_not_real';
process.env.APP_URL ||= 'https://www.joinivy.ai';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import unsubscribeHandler from '../api/unsubscribe.js';
import { mintUnsubscribeToken } from '../api/_lib/unsubscribeToken.js';
import { sendEmailToUser, sendEmailToClientByAddress, emailShell } from '../api/_lib/email.js';
import { renderTrialReminder } from '../api/_lib/subscriptionNotify.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

// Capture outbound Resend calls instead of sending.
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('resend.com')) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const mkRes = () => { const r = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, send(b) { r.body = b; return r; }, end() { return r; } }; return r; };
const hit = async (token, method = 'GET') => { const res = mkRes(); await unsubscribeHandler({ method, query: { token }, headers: {} }, res); return res; };
const tokenFrom = (html, all = false) => {
  const m = [...html.matchAll(/\/api\/unsubscribe\?token=([A-Za-z0-9_\-.]+)/g)].map((x) => x[1]);
  return all ? m[1] : m[0];
};

async function main() {
  await ensureSchemaApplied();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`unsub-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id, email`;
  const owner = u.rows[0];
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${owner.id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  const wsId = w.rows[0].id;
  const html = emailShell({ heading: 'Hello', body: '<p>Promo</p>' });

  console.log('\n[1] every preference-aware email carries a one-click unsubscribe and an unsubscribe-from-all link');
  sent.length = 0;
  let r = await sendEmailToUser({ userId: owner.id, type: 'marketing', to: owner.email, subject: 'Promo', html });
  assert(r.sent === true && sent.length === 1, 'marketing email sent while opted in');
  const body1 = sent[0].html;
  assert(/Unsubscribe<\/a>/.test(body1) && /Unsubscribe from all emails/.test(body1), 'footer has both links');
  assert(/List-Unsubscribe/.test(JSON.stringify(sent[0].headers || {})) && /One-Click/.test(JSON.stringify(sent[0].headers || {})), 'RFC 8058 one-click headers present');

  console.log('\n[2] clicking Unsubscribe (this kind) stops marketing but not billing');
  const t1 = tokenFrom(body1);
  let res = await hit(t1, 'GET');
  assert(res.statusCode === 200 && /unsubscribed/i.test(String(res.body)), 'confirmation page shown');
  sent.length = 0;
  r = await sendEmailToUser({ userId: owner.id, type: 'marketing', to: owner.email, subject: 'Promo 2', html });
  assert(r.sent === false && r.reason === 'muted' && sent.length === 0, 'next marketing email is muted');
  r = await sendEmailToUser({ userId: owner.id, type: 'billing', to: owner.email, subject: 'Receipt', html });
  assert(r.sent === true && sent.length === 1, 'billing email still goes');

  console.log('\n[3] Gmail-style one-click POST on "Unsubscribe from all" stops every optional category');
  const tAll = tokenFrom(sent[0].html, true);
  res = await hit(tAll, 'POST');
  assert(res.statusCode === 200 && res.body?.ok === true, 'POST returns 200 { ok: true }');
  sent.length = 0;
  for (const type of ['billing', 'reports', 'bookings', 'invoices', 'documents', 'messages', 'marketing']) {
    // eslint-disable-next-line no-await-in-loop
    r = await sendEmailToUser({ userId: owner.id, type, to: owner.email, subject: type, html });
    assert(r.sent === false && r.reason === 'muted', `${type}: muted`);
  }
  r = await sendEmailToUser({ userId: owner.id, type: 'password_reset', to: owner.email, subject: 'Reset', html });
  assert(r.sent === true, 'account-critical email (password reset) still delivered');
  const prefs = (await sql`SELECT notification_prefs FROM users WHERE id = ${owner.id}`).rows[0].notification_prefs;
  assert(prefs.email_marketing === false && prefs.email_billing === false, 'preferences persisted in the database');

  console.log('\n[4] client of a business: unsubscribe by address sticks for that business');
  const clientEmail = `client-${S}@example.com`;
  await sql`INSERT INTO clients (workspace_id, name, email) VALUES (${wsId}, 'Casey', ${clientEmail})`;
  sent.length = 0;
  r = await sendEmailToClientByAddress({ workspaceId: wsId, email: clientEmail, type: 'marketing', subject: 'Review us', html });
  assert(r.sent === true, 'client marketing sent while opted in');
  res = await hit(tokenFrom(sent[0].html), 'POST');
  r = await sendEmailToClientByAddress({ workspaceId: wsId, email: clientEmail, type: 'marketing', subject: 'Review us again', html });
  assert(r.sent === false && r.reason === 'muted', 'client marketing muted after one click');

  console.log('\n[5] waitlist: opt-out column honoured by the announce query');
  const wl = `wait-${S}@example.com`;
  await sql`INSERT INTO waitlist_signups (email, first_name, contact_consent) VALUES (${wl}, 'Wren', TRUE)`;
  const tw = mintUnsubscribeToken({ scope: 'waitlist', id: wl, type: 'all' });
  res = await hit(tw, 'GET');
  assert(res.statusCode === 200, 'waitlist unsubscribe accepted');
  const wrow = (await sql`SELECT unsubscribed_at FROM waitlist_signups WHERE email = ${wl}`).rows[0];
  assert(!!wrow.unsubscribed_at, 'unsubscribed_at stamped');
  const eligible = (await sql`SELECT 1 FROM waitlist_signups WHERE notified_at IS NULL AND contact_consent IS DISTINCT FROM false AND unsubscribed_at IS NULL AND email = ${wl}`).rows;
  assert(eligible.length === 0, 'excluded from the announce audience');

  console.log('\n[6] bad tokens change nothing');
  res = await hit('not.a.token', 'POST');
  assert(res.statusCode === 400, 'garbage token → 400');
  res = await hit(t1.slice(0, -2) + 'xx', 'GET');
  assert(res.statusCode === 400, 'tampered token → 400');

  console.log('\n[7] trial-ended email no longer promises a free account');
  const te = renderTrialReminder({ stage: 'expired', trialEndsAt: new Date(), firstName: 'Kay', businessName: 'Glow' });
  assert(!/free Client account|Nothing was deleted|free account/.test(te.html) && /4 weeks/.test(te.html) && /permanently deleted/.test(te.html), 'states the 4-week retention instead');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
