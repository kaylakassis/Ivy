// What Ivy tells an owner about charges to their own card, after the
// 2026-11-24 Terms (section 19: renewals, free trials, cancellation).
//   [1] a trial with a card on file: the reminders say a charge is coming
//   [2] a trial with no card: the reminders are unchanged
//   [3] the purchase email: a trial start is not called a receipt
//   [4] notices about a charge cannot be switched off
//   [5] the reminder job treats the two kinds of trial differently
//   [6] starting checkout leaves a record of the agreement to renew
//   [7] the app's own screens say the same thing
//
// Run: node --import ./tests/bootstrap.mjs ./tests/billing-notices.test.mjs
import { readFileSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { renderTrialReminder, renderSubscriptionStarted, renderUpcomingRenewal, trialCharge } from '../api/_lib/subscriptionNotify.js';
import { CRITICAL_EMAIL_TYPES, userAllowsEmail } from '../api/_lib/notificationPrefs.js';
import { renewalConsentVersion, recordRenewalConsent, RENEWAL_TERMS_VERSION } from '../api/_lib/renewalConsent.js';

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_billing_notices';
const { default: trialReminders } = await import('../api/cron/trial-reminders.js');

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const text = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

// The mail provider accepts everything and we keep what was sent. Stripe
// answers for one made-up subscription.
const sent = [];
const SUBS = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('resend')) {
    try { sent.push(JSON.parse(init?.body || '{}')); } catch { /* not json */ }
    return new Response(JSON.stringify({ id: `stub-${Date.now()}` }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const m = /api\.stripe\.com\/v1\/subscriptions\/([^/?]+)/.exec(u);
  if (m) {
    const sub = SUBS[decodeURIComponent(m[1])];
    return new Response(JSON.stringify(sub || { error: { message: 'No such subscription' } }), { status: sub ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};
const stripeSub = (id, { amount = 899, interval = 'week', cancelled = false } = {}) => {
  SUBS[id] = { id, status: 'trialing', cancel_at_period_end: cancelled, items: { data: [{ price: { unit_amount: amount, currency: 'usd', recurring: { interval } } }] } };
  return id;
};
function mkRes() { return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, setHeader() {}, json(o) { this.body = o; return this; }, end() { return this; } }; }
const cronReq = () => ({ method: 'POST', url: '/api/cron/trial-reminders', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

const created = [];
async function mkTrial(tag, endInDays, { stripeSubId = null, source = null, prefs = null } = {}) {
  const email = `${tag}-${S}@example.com`;
  const uid = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at, notification_prefs)
    VALUES (${email}, 'x', 'Trial Owner', '2026-11-24', NOW(), ${JSON.stringify(prefs || {})}::jsonb) RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, stripe_subscription_id)
    VALUES (${uid}, 'trialing', NOW() + (${String(endInDays)} || ' days')::interval, ${stripeSubId}) RETURNING id`).rows[0].id;
  if (source) await sql`UPDATE workspaces SET subscription_source = ${source} WHERE id = ${ws}`;
  created.push({ uid, ws });
  return { uid, ws, email };
}
const stamps = async (ws) => (await sql`SELECT trial_reminder_2d_sent_at AS d2, trial_expired_notice_sent_at AS exp FROM workspaces WHERE id = ${ws}`).rows[0];
const mailTo = (email) => sent.filter((m) => [].concat(m.to || []).includes(email));

async function main() {
  await ensureSchemaApplied();
  const in2 = new Date(Date.now() + 2 * 864e5);
  const base = { trialEndsAt: in2, firstName: 'Casey', businessName: 'Casey & Co' };

  console.log('\n[1] a trial with a card on file');
  const card = { via: 'stripe', cancelled: false, amountCents: 899, currency: 'usd', interval: 'week' };
  for (const stage of ['7d', '2d', '1d']) {
    const r = renderTrialReminder({ ...base, stage, charge: card });
    const t = text(r?.html);
    assert(!!r && /your card will be charged \$8\.99/.test(t) && /renews by itself every week until you cancel/.test(t) && /cancel before .* and you will not be charged/.test(t) && /go to Account, then Plan, then Manage subscription/.test(t),
      `${stage}: says the card will be charged $8.99, that it renews every week, and how to cancel in time`);
    assert(!/there's no charge|pick a plan|until you pick a plan|until you choose a plan|pause until|stops until you subscribe/i.test(t), `${stage}: never says there is no charge or asks them to pick a plan`);
  }
  assert(/\$8\.99 will be charged/.test(renderTrialReminder({ ...base, stage: '2d', charge: card }).subject), 'the subject line carries the amount');
  assert(renderTrialReminder({ ...base, stage: 'expired', charge: card }) === null, 'there is no "your trial has ended, tools are off" email: the trial ending is the plan starting');
  const yearly = text(renderTrialReminder({ ...base, stage: '2d', charge: { ...card, amountCents: 37499, interval: 'year' } }).html);
  assert(/\$374\.99/.test(yearly) && /every year/.test(yearly), 'a yearly plan says its own price and "every year"');
  const off = text(renderTrialReminder({ ...base, stage: '2d', charge: { ...card, cancelled: true } }).html);
  assert(/you will not be charged/.test(off) && !/your card will be charged/.test(off), 'someone who already turned renewal off is told they will not be charged');
  const apple = text(renderTrialReminder({ ...base, stage: '1d', charge: { via: 'apple', cancelled: false, amountCents: null, interval: null } }).html);
  assert(/Apple will charge your Apple ID/.test(apple) && /at least a day before/.test(apple) && /Settings on your iPhone/.test(apple), 'an App Store trial names Apple, its one-day rule, and where to cancel on the phone');
  const unknown = text(renderTrialReminder({ ...base, stage: '2d', charge: { via: 'stripe', cancelled: false, amountCents: null, interval: null } }).html);
  assert(/your card will be charged/.test(unknown) && !/\$/.test(unknown) && !/undefined|null/.test(unknown), 'if the price cannot be looked up, it still says a charge is coming, with no made-up amount');
  assert(await trialCharge({ stripe_subscription_id: null, subscription_source: 'stripe' }) === null, 'a trial with no card on file is not treated as one that charges');
  const looked = await trialCharge({ stripe_subscription_id: stripeSub(`sub_look_${S}`, { amount: 37499, interval: 'year' }), subscription_source: 'stripe', cancel_at_period_end: false });
  assert(looked?.via === 'stripe' && looked.amountCents === 37499 && looked.interval === 'year' && looked.cancelled === false, 'the price and how often come from the subscription itself');
  const gone = await trialCharge({ stripe_subscription_id: `sub_missing_${S}`, subscription_source: 'stripe' });
  assert(gone?.via === 'stripe' && gone.amountCents === null, 'and a failed look-up degrades to "a charge is coming"');
  assert((await trialCharge({ subscription_source: 'apple' }))?.via === 'apple', 'an App Store trial is recognised');

  console.log('\n[2] a trial with no card');
  const plain = text(renderTrialReminder({ ...base, stage: '2d' }).html);
  assert(/there's no charge/.test(plain) && !/your card will be charged/.test(plain), 'the 2-day reminder still says there is no charge, which is true for them');
  assert(/Your trial has ended/.test(renderTrialReminder({ ...base, stage: 'expired' }).subject.replace('Ivy ', '')), 'and they still get the "trial has ended" email');

  console.log('\n[3] the purchase email');
  const trialMail = renderSubscriptionStarted({ periodEnd: in2, amountCents: 899, currency: 'usd', interval: 'week', trialEnd: in2, firstName: 'Casey', businessName: 'Casey & Co' });
  const tm = text(trialMail.html);
  assert(/free trial has started/i.test(trialMail.subject) && /Nothing has been charged/.test(tm) && /your card will be charged \$8\.99/.test(tm) && /every week until you cancel/.test(tm) && /cancel before .* and you will not be charged/.test(tm) && /Account, then Plan, then Manage subscription/.test(tm),
    'a trial start says nothing was charged, when the card will be, how much, how often, and how to cancel');
  assert(!/receipt/i.test(tm) && !/went through/.test(tm), 'and never calls it a receipt or a payment');
  const paidMail = text(renderSubscriptionStarted({ periodEnd: in2, amountCents: 899, paidCents: 719, currency: 'usd', interval: 'week', firstName: 'Casey', businessName: 'Casey & Co' }).html);
  assert(/Your payment of \$7\.19 went through/.test(paidMail) && /renews by itself every week at \$8\.99/.test(paidMail) && /To cancel, open Ivy, go to Account, then Plan, then Manage subscription/.test(paidMail) && /end of the period you have paid for/.test(paidMail),
    'a paid start gives the amount actually charged, the renewal price and period, and how to cancel');
  const old = text(renderSubscriptionStarted({ periodEnd: in2, amountCents: 4900, currency: 'USD', firstName: 'Test', businessName: 'Biz' }).html);
  assert(/Your payment of \$49\.00 went through/.test(old) && /renews by itself at \$49\.00/.test(old), 'a caller that passes only the old fields still gets a correct email');
  const renew = text(renderUpcomingRenewal({ periodEnd: in2, amountCents: 899, currency: 'usd', firstName: 'Casey', businessName: 'Casey & Co' }).html);
  assert(/renews by itself until you cancel/.test(renew) && /Account, then Plan, then Manage subscription/.test(renew), 'the renewal reminder says how to cancel');
  const hook = read('api/webhooks/billing.js');
  assert(/paidCents:\s+isTrialing \? null : \(typeof session\.amount_total === 'number' \? session\.amount_total : null\)/.test(hook) && /trialEnd:\s+isTrialing \? trialEnd : null/.test(hook) && /interval:\s+sub\?\.items\?\.data\?\.\[0\]\?\.price\?\.recurring\?\.interval/.test(hook),
    'checkout tells the email whether it was a trial start, what was really charged, and how often it renews');
  for (const html of [trialMail.html, renderTrialReminder({ ...base, stage: '2d', charge: card }).html]) assert(!/[–—]/.test(html), 'no dashes in what people read');

  console.log('\n[4] notices about a charge cannot be switched off');
  const muted = await mkTrial('bn-muted', 30, { prefs: { email_billing: false } });
  assert(CRITICAL_EMAIL_TYPES.has('billing_notice') && await userAllowsEmail(muted.uid, 'billing_notice') === true && await userAllowsEmail(muted.uid, 'billing') === false,
    'with "Subscription billing" emails off, a charge notice still sends and the optional ones do not');
  const notify = read('api/_lib/subscriptionNotify.js');
  const fnBody = (name) => notify.slice(notify.indexOf(`export async function ${name}`), notify.indexOf('\n}\n', notify.indexOf(`export async function ${name}`)));
  assert(/type: 'billing_notice'/.test(fnBody('notifySubscriptionStarted')) && /type: 'billing_notice'/.test(fnBody('notifyUpcomingRenewal')) && /type: charge \? 'billing_notice' : 'billing'/.test(fnBody('notifyTrialReminder')),
    'the purchase email, the renewal reminder and the card-trial reminders are sent as charge notices');
  assert(/type: 'billing'/.test(fnBody('notifySubscriptionCancelled')), 'cancellation confirmations stay under the owner\'s switch');

  console.log('\n[5] the reminder job');
  const cardTrial = await mkTrial('bn-card', 1.5, { stripeSubId: stripeSub(`sub_card_${S}`), prefs: { email_billing: false } });
  const noCard = await mkTrial('bn-nocard', 1.5, { prefs: { email_billing: false } });
  const cardEnded = await mkTrial('bn-card-ended', -1, { stripeSubId: stripeSub(`sub_ended_${S}`) });
  const appleEnded = await mkTrial('bn-apple-ended', -1, { source: 'apple' });
  const noCardEnded = await mkTrial('bn-nocard-ended', -1);
  sent.length = 0;
  const res = mkRes(); await trialReminders(cronReq(), res);
  assert(res.statusCode === 200, `the job runs (${res.statusCode})`);
  const cm = mailTo(cardTrial.email);
  assert(cm.length === 1 && /your card will be charged \$8\.99/.test(text(cm[0].html)) && !!(await stamps(cardTrial.ws)).d2, 'a card trial 2 days out is told about the charge, even with billing emails switched off');
  assert(mailTo(noCard.email).length === 0, 'a no-card trial with billing emails switched off is left alone, as before');
  assert(mailTo(cardEnded.email).length === 0 && !(await stamps(cardEnded.ws)).exp, 'a card trial that just ended is not told "your trial has ended, tools are off"');
  assert(mailTo(appleEnded.email).length === 0 && !(await stamps(appleEnded.ws)).exp, 'nor is an App Store trial');
  const ne = mailTo(noCardEnded.email);
  assert(ne.length === 1 && /trial has ended/i.test(ne[0].subject) && !!(await stamps(noCardEnded.ws)).exp, 'a no-card trial that ended still gets its notice');

  console.log('\n[6] a record of the agreement to renew');
  assert(renewalConsentVersion({ plan: 'annual', trialDays: 14, shown: 'paywall' }) === `${RENEWAL_TERMS_VERSION}:annual:trial-14d:paywall`
    && renewalConsentVersion({ plan: 'monthly', trialDays: undefined, shown: 'account-confirm' }) === `${RENEWAL_TERMS_VERSION}:weekly:no-trial:account-confirm`
    && renewalConsentVersion({ plan: 'monthly', shown: '<script>' }) === `${RENEWAL_TERMS_VERSION}:weekly:no-trial:not-stated`,
    'the record names the plan, whether a trial came first, and which screen they were on (nothing a browser sends is stored as is)');
  const okRec = await recordRenewalConsent({ userId: muted.uid, req: { headers: { 'user-agent': 'TestBrowser/1.0', 'x-real-ip': '198.51.100.77' } }, plan: 'monthly', trialDays: 14, shown: 'paywall' });
  const row = (await sql`SELECT document, version, ip, user_agent, accepted_at FROM legal_acceptances WHERE user_id = ${muted.uid} AND document = 'auto_renewal'`).rows[0];
  assert(okRec === true && row?.version === `${RENEWAL_TERMS_VERSION}:weekly:trial-14d:paywall` && row.user_agent === 'TestBrowser/1.0' && !!row.accepted_at, 'it is stored with the time and the browser, next to their acceptance of the Terms');
  assert(await recordRenewalConsent({ userId: null, plan: 'monthly' }) === false && await recordRenewalConsent({ userId: '00000000-0000-0000-0000-000000000000', plan: 'monthly' }) === false, 'a record that cannot be written returns quietly and never throws');
  const checkout = read('api/billing/checkout.js');
  assert(/await recordRenewalConsent\(\{ userId: user\.id, req, plan, trialDays, shown: body\?\.shown \}\);\s+return ok\(res, \{ url: session\.url \}\);/.test(checkout), 'checkout writes it just before handing over the payment page');
  assert(/api\.post\('\/billing\/checkout', \{ plan, shown: 'paywall' \}\)/.test(read('src/features/billing/Paywall.jsx')) && /api\.post\('\/billing\/checkout', \{ shown: 'account-confirm' \}\)/.test(read('src/features/account/AccountPage.jsx')),
    'both screens that can start checkout say which one they are');
  const banner = read('src/features/billing/SubscriptionBanner.jsx');
  assert(!/billing\/checkout/.test(banner) && /nav\('\/account\?tab=billing'\)/.test(banner), 'the trial banner no longer jumps straight to payment; it opens the Plan page, which explains renewal first');

  console.log('\n[7] the app\'s own screens');
  const paywall = read('src/features/billing/Paywall.jsx');
  assert(/data-first-charge>\{' '\}Your card is charged on \{new Date\(Date\.now\(\) \+ TRIAL_DAYS \* 864e5\)/.test(paywall) && /canTrial && !winback && !\(isNative\(\) && isIos\(\)\)/.test(paywall), 'the paywall names the day the card is charged when a free trial is offered on the web');
  const account = read('src/features/account/AccountPage.jsx');
  assert(/Ivy Weekly is \$\{IVY_PRICE\} every week/.test(account) && /until you cancel/.test(account) && /Cancel before that date and you are not charged/.test(account) && !/monthly or annual/.test(account), 'the confirmation before checkout gives the price, the period, the trial and how to avoid a charge');
  assert(/sub\.status === 'trialing' && sub\.trialHasCard && sub\.cancelAtPeriodEnd/.test(account) && /your card is charged and the plan renews by itself until you cancel/.test(account) && /sub\.stripeCustomerId \|\| sub\.trialHasCard \|\|/.test(account),
    'the Plan page tells a card trial about the charge and always shows the way to cancel');
  assert(/\(!sub\.isActive \|\| \(sub\.status === 'trialing' && !sub\.trialHasCard\)\) && \(\s*<button className="btn btn-primary" onClick=\{subscribeNow\}/.test(account), 'an owner on a trial with no card finds the Subscribe button on the Plan page the banner sends them to');
  assert(/sub\.trialHasCard/.test(banner) && /Your card is then charged and your plan renews by itself until you cancel/.test(banner) && /Renewal is off, so you will not be charged/.test(banner), 'so does the "trial ends soon" banner');
  const portal = read('api/_lib/clientPortal.js');
  assert(/trialHasCard: trialActive \? !!\(row\.stripe_subscription_id \|\| row\.subscription_source === 'apple'\) : false/.test(portal) && /w\.stripe_customer_id, w\.stripe_subscription_id,/.test(portal), 'the server tells the app which kind of trial it is');
  assert(/Emails about a charge \(your purchase, a renewal, a trial about to become a paid plan, a failed payment\) always send/.test(account), 'the email switch says what it does not cover');
  assert(/Export your data/.test(account) && !/every row tied to your workspace/.test(account) && /Files you uploaded are not inside it/.test(account), 'the export card says what the file holds instead of "every row"');
  assert(/Choose the weekly plan/.test(checkout) && !/Choose monthly/.test(checkout), 'no message tells anyone to choose a monthly plan that does not exist');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const { uid, ws } of created) {
    await sql`DELETE FROM workspaces WHERE id = ${ws}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
  }
  globalThis.fetch = realFetch;
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
