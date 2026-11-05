// The accountability partner (1.0.6): the shared signals list, the hourly
// cron, the settings endpoint, snooze, Ivy's tool, and the dashboard's new
// key numbers.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/accountability-partner.test.mjs
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import {
  computeSignals, composeMessage, messageableItems, isFresh, resolvePartnerSettings, cleanSettingsPatch,
  renderPartnerEmail, firstNameOf, QUIET_DAYS,
} from '../api/_lib/accountability.js';
import { keyNumbers } from '../api/_lib/dashboardNumbers.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';
import { executePendingAction } from '../api/_lib/ivyApproval.js';
const { default: partnerCron, shouldEmail } = await import('../api/cron/accountability-partner.js');
const { default: partnerApi } = await import('../api/me/accountability.js');
const { default: dashboard } = await import('../api/dashboard.js');
const { default: notificationsApi } = await import('../api/me/notifications.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const emails = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('resend.com')) {
    try { emails.push(JSON.parse(init.body)); } catch { emails.push({}); }
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const mailsTo = (addr) => emails.filter((m) => JSON.stringify(m.to || '').toLowerCase().includes(addr.toLowerCase()));

const mkRes = () => ({
  statusCode: 200, headers: {}, body: null,
  status(c) { this.statusCode = c; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  getHeader(k) { return this.headers[k.toLowerCase()]; },
  json(o) { this.body = o; return this; }, send(o) { this.body = o; return this; },
  end(s) { if (s !== undefined) this.body = s; return this; },
});
const authReq = (uid, method = 'GET', body = null, extra = {}) => ({
  method, url: '/api/me/accountability', query: {},
  headers: {
    host: 'localhost:3001', origin: 'http://localhost:3001', 'user-agent': 'test/1.0',
    'content-type': 'application/json', cookie: `ivy_session=${signSession(uid)}`, ...extra,
  },
  body, on() {},
});
const cronReq = () => ({ method: 'POST', url: '/api/cron/accountability-partner', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

// A DST-free zone whose local hour == targetHour right now.
function zoneForLocalHour(targetHour) {
  const utcH = new Date().getUTCHours();
  let o = ((targetHour - utcH) % 24 + 24) % 24;
  if (o > 14) o -= 24;
  if (o === 0) return 'UTC';
  return o > 0 ? `Etc/GMT-${o}` : `Etc/GMT+${-o}`;
}

const TAG = `ap${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const created = [];
async function mkOwner(t, { tz = zoneForLocalHour(11), status = 'active', prefs = {}, userType = 'regular', tester = false, lastActiveAgo = '1 hour', onboarded = true } = {}) {
  const email = `${TAG}-${t}@example.com`;
  const uid = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at, email_verified_at, notification_prefs, user_type, is_tester, last_active_at)
    VALUES (${email}, 'x', 'Kayla Owner', '2026-05-05', NOW(), NOW(), ${JSON.stringify(prefs)}::jsonb, ${userType}, ${tester}, NOW() - ${lastActiveAgo}::interval)
    RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, ${status}, NOW() + INTERVAL '30 days', ${onboarded ? new Date().toISOString() : null}) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, availability)
    VALUES (${ws}, 'Studio', ${`${TAG}-${t}`}, ${tz}, '{"mon":[{"start":"09:00","end":"17:00"}]}'::jsonb)`;
  await sql`INSERT INTO services (workspace_id, name, price, duration_minutes) VALUES (${ws}, 'Session', 80, 60)`;
  const o = { uid, ws, email, tz };
  created.push(o);
  return o;
}
async function mkClient(o, name, { email = null, stage = 'active', ageDays = 60, source = null } = {}) {
  return (await sql`INSERT INTO clients (workspace_id, name, email, stage, source, created_at)
    VALUES (${o.ws}, ${name}, ${email}, ${stage}, ${source}, NOW() - ${`${ageDays} days`}::interval) RETURNING id`).rows[0].id;
}
const one = async (q) => (await q).rows[0];
const feed = async (uid, tag) => (await sql`SELECT type, title, body, url FROM notifications WHERE user_id = ${uid} AND tag = ${tag} ORDER BY created_at DESC`).rows;
const wsRow = async (ws) => one(sql`SELECT *, partner_last_sent_at::text AS sent_text FROM workspaces WHERE id = ${ws}`);
// Make the cron look at a business again (as if 3 hours passed) and, with
// newDay, as if it were the next day.
const again = async (ws, { newDay = false } = {}) => {
  await sql`UPDATE workspaces SET partner_checked_at = NULL WHERE id = ${ws}`;
  if (newDay) await sql`UPDATE workspaces SET partner_last_sent_day = partner_last_sent_day - 1 WHERE id = ${ws} AND partner_last_sent_day IS NOT NULL`;
};

// Seed one of everything the partner looks for.
async function seedBusy(o) {
  const jane = await mkClient(o, 'Jane Doe-Smith', { email: `${TAG}-jane@example.com` });
  const t = await one(sql`INSERT INTO message_threads (workspace_id, client_id, unread_biz, last_message_at, last_message_preview)
    VALUES (${o.ws}, ${jane}, 1, NOW() - INTERVAL '6 hours', 'my divorce papers are ready') RETURNING id`);
  await sql`INSERT INTO messages (thread_id, sender, text, created_at) VALUES (${t.id}, 'client', 'my divorce papers are ready', NOW() - INTERVAL '6 hours')`;
  await mkClient(o, 'Leo Lead', { stage: 'lead', ageDays: 2 });
  const maria = await mkClient(o, 'Maria Gonzalez', { email: `${TAG}-maria@example.com` });
  await sql`INSERT INTO documents (workspace_id, name, recipient_client_id, recipient_name, recipient_email, status, created_at)
    VALUES (${o.ws}, 'Medical waiver', ${maria}, 'Maria Gonzalez', ${`${TAG}-maria@example.com`}, 'draft', NOW() - INTERVAL '2 days')`;
  await sql`INSERT INTO documents (workspace_id, name, recipient_client_id, recipient_name, status, sent_at)
    VALUES (${o.ws}, 'Contract', ${maria}, 'Maria Gonzalez', 'sent', NOW() - INTERVAL '5 days')`;
  await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status, created_at)
    VALUES (${o.ws}, 'D-1', ${maria}, 'Maria Gonzalez', '[]'::jsonb, 'draft', NOW() - INTERVAL '3 days')`;
  await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status)
    VALUES (${o.ws}, 'O-1', ${jane}, 'Jane Doe-Smith', ${JSON.stringify([{ description: 'x', quantity: 1, rate: 120 }])}::jsonb, 'overdue')`;
  await sql`INSERT INTO tasks (workspace_id, title, due_date) VALUES (${o.ws}, 'Call the accountant', CURRENT_DATE - 1)`;
  const quiet = await mkClient(o, 'Quentin Quiet', { email: `${TAG}-q@example.com`, ageDays: 90 });
  await sql`INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining, status)
    VALUES (${o.ws}, ${quiet}, '5 pack', 5, 1, 'active')`;
  await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text) VALUES (${o.ws}, 'Rita Reviewer', 5, 'Great')`;
  const noEmail = await mkClient(o, 'Ned Noemail');
  await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
    VALUES (${o.ws}, ${noEmail}, 'Ned Noemail', '', CURRENT_DATE + 2, 600, 660)`;
  await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, cancelled_at,
      deposit_required, deposit_paid, deposit_refund_request_status, deposit_refund_requested_at)
    VALUES (${o.ws}, ${maria}, 'Maria Gonzalez', 'm@example.com', CURRENT_DATE + 1, 600, 660, NOW(), 20, 20, 'pending', NOW())`;
  await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, deposit_required)
    VALUES (${o.ws}, ${noEmail}, 'Ned Noemail', '', (NOW() AT TIME ZONE ${o.tz})::date, 900, 960, 25)`;
  // Sample data never counts.
  const demo = await mkClient(o, 'Sample Sam', { source: 'demo', ageDays: 90 });
  const dt = await one(sql`INSERT INTO message_threads (workspace_id, client_id, unread_biz, last_message_at)
    VALUES (${o.ws}, ${demo}, 1, NOW() - INTERVAL '9 hours') RETURNING id`);
  return { jane, maria, quiet, demoThread: dt.id };
}

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] signals: each one, first names only, sample data ignored');
  const A = await mkOwner('a');
  await seedBusy(A);
  const items = await computeSignals(A.ws);
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  for (const k of ['unread_messages', 'leads_waiting', 'deposit_reviews', 'invoices_overdue', 'docs_unsent', 'docs_unsigned',
    'invoices_draft', 'tasks_due', 'quiet_clients', 'packages_low', 'reviews_reply', 'missing_email', 'deposits_unpaid_today']) {
    assert(!!by[k], `signal ${k} found`);
  }
  assert(by.unread_messages?.count === 1 && by.unread_messages.title === 'Reply to Jane', `unread: Jane only, sample thread ignored (${by.unread_messages?.title})`);
  assert(/^\/messages\?threadId=/.test(by.unread_messages?.href || ''), 'unread deep-links to the thread');
  assert(by.invoices_overdue?.detail === '$120 outstanding', `overdue amount in detail (${by.invoices_overdue?.detail})`);
  assert(by.docs_unsent?.title === "Send Maria's document" && /Medical waiver/.test(by.docs_unsent.detail), 'unsent doc: name only in detail');
  // Quentin and Maria (her only booking was cancelled); Jane messaged, Ned
  // has an upcoming booking, Leo is a lead, Ali/Sam do not count.
  assert(by.quiet_clients?.count === 2 && by.quiet_clients.title === 'Check in with Maria and Quentin', `quiet: shared definition (${by.quiet_clients?.title})`);
  assert(by.deposits_unpaid_today?.title === "Ned's deposit for today is not paid yet", `unpaid deposit today (${by.deposits_unpaid_today?.title})`);
  assert(by.setup === undefined || by.setup.inAppOnly === true, 'setup gap is in-app only');
  assert(items[0].priority === 1 && items[items.length - 1].priority >= items[0].priority, 'sorted by priority');
  const allText = JSON.stringify(items.map((i) => [i.title, i.phrase]));
  assert(!/Doe|Smith|Gonzalez|Owner|divorce|@/.test(allText), 'titles and phrases carry first names only, no message text or emails');
  const msg = composeMessage({ kind: 'digest', items: messageableItems(items, resolvePartnerSettings({}, {})) });
  assert(!/Doe|Smith|Gonzalez|divorce|waiver|accountant|\$/.test(msg.body), `push body: no surnames, document names, task titles or amounts (${msg.body})`);
  assert(/worth 5 minutes today: reply to Jane/.test(msg.body), 'digest wording');
  assert(firstNameOf('jane@x.com') === '' && firstNameOf('  Ana  Lee ') === 'Ana', 'firstNameOf never returns an email');

  console.log('\n[2] workspace isolation');
  const B = await mkOwner('b');
  const itemsB = await computeSignals(B.ws);
  assert(!itemsB.some((i) => ['unread_messages', 'invoices_overdue', 'docs_unsent', 'quiet_clients'].includes(i.key)),
    `another business sees none of A's items (${itemsB.map((i) => i.key)})`);

  console.log('\n[3] cron: one digest a day, in the owner\'s local hours');
  let res = mkRes();
  await partnerCron(cronReq(), res);
  assert(res.statusCode === 200, 'cron ok');
  let rows = await feed(A.uid, 'accountability-partner');
  assert(rows.length === 1 && rows[0].type === 'accountability' && rows[0].title === 'Ivy, your accountability partner', 'A got one in-app digest');
  assert(!/Doe|Smith|Gonzalez/.test(rows[0].body), 'bell/push body has first names only');
  let w = await wsRow(A.ws);
  assert(!!w.partner_last_sent_day && w.partner_mentioned.unread_messages?.fp, 'day claimed and mentions recorded');
  assert(mailsTo(A.email).length === 1, 'no device reached → one email');
  const mail = mailsTo(A.email)[0];
  assert(mail && /worth 5 minutes today/.test(mail.subject) && /Unsubscribe|unsubscribe/.test(JSON.stringify(mail.headers || {})), 'email: subject + List-Unsubscribe');
  assert(mail && !/divorce/.test(mail.html) && /Medical waiver/.test(mail.html), 'email body: details yes, message text never');
  await again(A.ws);
  await partnerCron(cronReq(), mkRes());
  assert((await feed(A.uid, 'accountability-partner')).length === 1 && mailsTo(A.email).length === 1, 'same day: nothing more');

  console.log('\n[4] next day: only new things (or past their repeat window) speak up');
  await again(A.ws, { newDay: true });
  await sql`UPDATE workspaces SET partner_mentioned = (SELECT jsonb_object_agg(k, jsonb_build_object('at', NOW() - INTERVAL '2 hours', 'fp', v->>'fp'))
             FROM jsonb_each(partner_mentioned) AS e(k, v)) WHERE id = ${A.ws}`;
  const sentBefore = (await wsRow(A.ws)).sent_text;
  await partnerCron(cronReq(), mkRes());
  assert(String((await wsRow(A.ws)).sent_text) === String(sentBefore), 'nothing new and all mentioned 2 hours ago → no message');
  await sql`UPDATE message_threads SET last_message_at = NOW() - INTERVAL '5 hours' WHERE workspace_id = ${A.ws}`;
  const ali = await mkClient(A, 'Ali Newcomer');
  await sql`INSERT INTO message_threads (workspace_id, client_id, unread_biz, last_message_at) VALUES (${A.ws}, ${ali}, 2, NOW() - INTERVAL '5 hours')`;
  await again(A.ws);
  await partnerCron(cronReq(), mkRes());
  rows = await feed(A.uid, 'accountability-partner');
  assert(String((await wsRow(A.ws)).sent_text) !== String(sentBefore) && /Ali|Jane/.test(rows[0].body), `a new message → a new digest (${rows[0]?.body})`);
  assert(isFresh({ key: 'x', priority: 3, fingerprint: 'f' }, { x: { at: new Date(Date.now() - 8 * 86400000).toISOString(), fp: 'f' } }), 'low-priority item repeats after 7 days');
  assert(!isFresh({ key: 'x', priority: 3, fingerprint: 'f' }, { x: { at: new Date(Date.now() - 2 * 86400000).toISOString(), fp: 'f' } }), 'but not after 2');

  console.log('\n[5] quiet hours, the switch, snooze, testers, no plan, not onboarded');
  const night = await mkOwner('night', { tz: zoneForLocalHour(21) }); await seedBusy(night);
  const early = await mkOwner('early', { tz: zoneForLocalHour(7) }); await seedBusy(early);
  const off = await mkOwner('off', { prefs: { accountability: false } }); await seedBusy(off);
  const snoozed = await mkOwner('snz'); await seedBusy(snoozed);
  await sql`UPDATE workspaces SET partner_snoozed_day = (NOW() AT TIME ZONE ${snoozed.tz})::date WHERE id = ${snoozed.ws}`;
  const tester = await mkOwner('tst', { tester: true }); await seedBusy(tester);
  const beta = await mkOwner('beta', { userType: 'beta' }); await seedBusy(beta);
  const noplan = await mkOwner('np', { status: 'incomplete' }); await seedBusy(noplan);
  const lapsed = await mkOwner('lap', { status: 'canceled' }); await seedBusy(lapsed);
  const notOnb = await mkOwner('nob', { onboarded: false }); await seedBusy(notOnb);
  const setupDay = await mkOwner('sud'); await seedBusy(setupDay);
  await sql`UPDATE workspaces SET setup_nudge_sent_at = NOW() - INTERVAL '2 hours' WHERE id = ${setupDay.ws}`;
  await partnerCron(cronReq(), mkRes());
  for (const [o, label] of [[night, '9pm local'], [early, '7am local'], [off, 'switched off'], [snoozed, 'snoozed today'],
    [tester, 'tester'], [beta, 'beta account'], [noplan, 'no plan (gets sign-up reminders)'], [lapsed, 'cancelled plan'],
    [notOnb, 'not onboarded'], [setupDay, 'setup email went out today']]) {
    const n = (await feed(o.uid, 'accountability-partner')).length + (await feed(o.uid, 'accountability-away')).length;
    assert(n === 0 && mailsTo(o.email).length === 0, `${label}: nothing sent`);
  }

  const sn = await mkOwner('sn');
  await sql`UPDATE users SET email_verified_at = NULL WHERE id = ${sn.uid}`;
  await sql`UPDATE workspaces SET subscription_status = 'trialing', trial_ends_at = NOW() + INTERVAL '10 days',
              onboarded_at = NOW() - INTERVAL '3 days', partner_last_sent_at = NOW() - INTERVAL '1 hour' WHERE id = ${sn.ws}`;
  const { default: setupNudge } = await import('../api/cron/setup-nudge.js');
  await setupNudge({ method: 'POST', url: '/api/cron/setup-nudge', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, mkRes());
  assert((await wsRow(sn.ws)).setup_nudge_sent_at === null, 'setup email waits when the partner already wrote today');
  await sql`UPDATE workspaces SET partner_last_sent_at = NOW() - INTERVAL '30 hours' WHERE id = ${sn.ws}`;
  await setupNudge({ method: 'POST', url: '/api/cron/setup-nudge', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, mkRes());
  assert((await wsRow(sn.ws)).setup_nudge_sent_at !== null, 'and goes out the next day');

  console.log('\n[6] owners only: a helper on the business gets nothing');
  const helperUid = (await one(sql`INSERT INTO users (email, password_hash, name) VALUES (${`${TAG}-helper@example.com`}, 'x', 'Hal Helper') RETURNING id`)).id;
  await sql`INSERT INTO staff_members (workspace_id, user_id, name, email, active, permissions)
    VALUES (${A.ws}, ${helperUid}, 'Hal Helper', ${`${TAG}-helper@example.com`}, TRUE, '{"schedule":true,"messages":true}'::jsonb)`;
  await again(A.ws, { newDay: true });
  await sql`UPDATE workspaces SET partner_mentioned = '{}'::jsonb WHERE id = ${A.ws}`;
  await partnerCron(cronReq(), mkRes());
  const helperRows = (await sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${helperUid}`).rows[0].n;
  assert(helperRows === 0 && mailsTo(`${TAG}-helper@example.com`).length === 0, 'helper: no notification, no email');

  console.log('\n[7] away: 3-day check-in, 7-day gentler one, then stop until they return');
  const away = await mkOwner('away', { lastActiveAgo: '4 days' }); await seedBusy(away);
  await partnerCron(cronReq(), mkRes());
  let ar = await feed(away.uid, 'accountability-away');
  assert(ar.length === 1 && /It's been a few days/.test(ar[0].body), `3-day check-in sent (${ar[0]?.body})`);
  assert((await feed(away.uid, 'accountability-partner')).length === 0, 'no regular digest while away');
  assert((await wsRow(away.ws)).partner_away_step === 1, 'step 1 recorded');
  assert(mailsTo(away.email).length === 1 && /catch-up/.test(mailsTo(away.email)[0].subject), 'check-in also emailed');
  await again(away.ws, { newDay: true });
  await partnerCron(cronReq(), mkRes());
  assert((await feed(away.uid, 'accountability-away')).length === 1 && (await feed(away.uid, 'accountability-partner')).length === 0, 'day 5: nothing (no daily nagging while away)');
  await sql`UPDATE users SET last_active_at = NOW() - INTERVAL '8 days' WHERE id = ${away.uid}`;
  await sql`UPDATE workspaces SET partner_away_sent_at = NOW() - INTERVAL '1 hour' WHERE id = ${away.ws}`;
  await again(away.ws, { newDay: true });
  await partnerCron(cronReq(), mkRes());
  ar = await sql`SELECT body FROM notifications WHERE user_id = ${away.uid} AND tag = 'accountability-away'`;
  assert(/Just checking in/.test(ar.rows[0]?.body || ''), `7-day gentler check-in (${ar.rows[0]?.body})`);
  assert((await wsRow(away.ws)).partner_away_step === 2, 'step 2 recorded');
  const before7 = (await wsRow(away.ws)).sent_text;
  await again(away.ws, { newDay: true });
  await sql`UPDATE users SET last_active_at = NOW() - INTERVAL '20 days' WHERE id = ${away.uid}`;
  await partnerCron(cronReq(), mkRes());
  assert(String((await wsRow(away.ws)).sent_text) === String(before7), 'after both check-ins: stops');
  await sql`UPDATE users SET last_active_at = NOW() WHERE id = ${away.uid}`;
  await sql`UPDATE workspaces SET partner_mentioned = '{}'::jsonb WHERE id = ${away.ws}`;
  await again(away.ws, { newDay: true });
  await partnerCron(cronReq(), mkRes());
  assert((await feed(away.uid, 'accountability-partner')).length === 1, 'back in the app: regular digests resume');
  const checkinsOff = await mkOwner('nochk', { lastActiveAgo: '4 days' });
  await sql`UPDATE users SET accountability_prefs = '{"kinds":{"checkins":false}}'::jsonb WHERE id = ${checkinsOff.uid}`;
  await partnerCron(cronReq(), mkRes());
  assert((await feed(checkinsOff.uid, 'accountability-away')).length === 0, 'check-ins switched off: no away message');

  console.log('\n[8] frequency + kinds + email choice');
  const imp = await mkOwner('imp'); await seedBusy(imp);
  await sql`UPDATE users SET accountability_prefs = '{"frequency":"important","kinds":{"messages":false}}'::jsonb WHERE id = ${imp.uid}`;
  await partnerCron(cronReq(), mkRes());
  const impRow = (await feed(imp.uid, 'accountability-partner'))[0];
  assert(impRow && !/reply to Jane/.test(impRow.body) && /chase an overdue invoice/.test(impRow.body) && !/quiet/.test(impRow.body),
    `important only, messages off (${impRow?.body})`);
  const s = resolvePartnerSettings({}, { frequency: 'important' });
  assert(messageableItems(items, s).every((i) => i.priority === 1), 'important keeps priority 1 only');
  assert(shouldEmail({ kind: 'digest', emailEnabled: true, hasEmail: true, reachedDevice: true }) === true, 'daily digest is emailed too, even when it reached a phone');
  assert(shouldEmail({ kind: 'digest', emailEnabled: true, hasEmail: true, reachedDevice: false }) === true, 'no device: email');
  assert(shouldEmail({ kind: 'away1', emailEnabled: true, hasEmail: true, reachedDevice: true }) === true, 'check-ins: always emailed');
  assert(shouldEmail({ kind: 'away1', emailEnabled: false, hasEmail: true, reachedDevice: false }) === false, 'email switched off: never');
  const noMail = await mkOwner('nomail', { prefs: { email_accountability: false } }); await seedBusy(noMail);
  await partnerCron(cronReq(), mkRes());
  assert((await feed(noMail.uid, 'accountability-partner')).length === 1 && mailsTo(noMail.email).length === 0, 'email off: in-app only');
  const weekly = await mkOwner('wk'); await seedBusy(weekly);
  await sql`UPDATE users SET accountability_prefs = '{"frequency":"weekly"}'::jsonb WHERE id = ${weekly.uid}`;
  await sql`UPDATE workspaces SET partner_last_sent_at = NOW() - INTERVAL '3 days', partner_last_sent_day = CURRENT_DATE - 3 WHERE id = ${weekly.ws}`;
  await partnerCron(cronReq(), mkRes());
  assert((await feed(weekly.uid, 'accountability-partner')).length === 0, 'weekly: nothing 3 days after the last one');

  console.log('\n[9] settings endpoint: read, change, warning-free validation, snooze, owners only');
  res = mkRes();
  await partnerApi(authReq(A.uid), res);
  assert(res.statusCode === 200 && res.body.enabled === true && res.body.frequency === 'daily' && Array.isArray(res.body.items), 'GET: on by default, with the list');
  assert(res.body.items.every((i) => !('ids' in i) && !('phrase' in i)), 'GET items: public shape only');
  res = mkRes();
  await partnerApi(authReq(A.uid, 'PATCH', { enabled: false }), res);
  assert(res.statusCode === 200 && res.body.enabled === false, 'PATCH enabled:false');
  const np = (await one(sql`SELECT notification_prefs FROM users WHERE id = ${A.uid}`)).notification_prefs;
  assert(np.accountability === false, 'stored as the accountability notification switch');
  res = mkRes();
  await notificationsApi(authReq(A.uid), res);
  assert(res.body.pushPrefs.accountability === false && !res.body.pushTypes.includes('accountability') && !res.body.emailTypes.includes('accountability'),
    'notifications GET: value present, not in the generic lists older apps draw');
  res = mkRes();
  await partnerApi(authReq(A.uid, 'PATCH', { enabled: true, frequency: 'weekly', kinds: { clients: false } }), res);
  assert(res.body.enabled && res.body.frequency === 'weekly' && res.body.kinds.clients === false && res.body.kinds.money === true, 'PATCH frequency + one kind');
  for (const [b, label] of [[{ frequency: 'hourly' }, 'bad frequency'], [{ kinds: { spam: true } }, 'unknown kind'], [{ enabled: 'yes' }, 'non-boolean'], [{}, 'empty']]) {
    res = mkRes();
    await partnerApi(authReq(A.uid, 'PATCH', b), res);
    assert(res.statusCode === 400, `${label}: 400`);
  }
  res = mkRes();
  await partnerApi(authReq(A.uid, 'PATCH', { enabled: false }, { origin: 'https://evil.example.com' }), res);
  assert(res.statusCode === 403, `cross-site PATCH refused (${res.statusCode})`);
  res = mkRes();
  await partnerApi(authReq(A.uid, 'POST', { action: 'snooze' }), res);
  assert(res.statusCode === 200 && res.body.snoozedToday === true, 'POST snooze');
  res = mkRes();
  await partnerApi(authReq(A.uid), res);
  assert(res.body.snoozedToday === true, 'GET shows snoozed today');
  res = mkRes();
  await partnerApi(authReq(A.uid, 'POST', { action: 'unsnooze' }), res);
  assert(res.body.snoozedToday === false, 'POST unsnooze');
  assert(cleanSettingsPatch({ emailEnabled: false }).notificationPatch.email_accountability === false, 'email switch maps to email_accountability');
  res = mkRes();
  await partnerApi(authReq(helperUid), res);
  assert(res.statusCode === 403, `helper-only account: 403 (${res.statusCode})`);
  res = mkRes();
  await partnerApi(authReq(B.uid), res);
  assert(!res.body.items.some((i) => /Jane|Maria/.test(i.title)), "owner B's endpoint never shows A's clients");

  console.log('\n[10] Ivy: reads straight away, changes only with approval');
  await sql`UPDATE users SET accountability_prefs = '{}'::jsonb WHERE id = ${A.uid}`;
  const ctx = { workspaceId: A.ws, userId: A.uid };
  const got = await executeIvyTool('accountability_partner', { action: 'get' }, ctx);
  assert(!got.needs_confirmation && got.enabled === true && Array.isArray(got.needs_attention) && got.needs_attention.length > 0, 'get: no card, returns the list');
  const held = await executeIvyTool('accountability_partner', { action: 'update', enabled: false }, ctx);
  assert(held.needs_confirmation === true && /help you stay on top of things/.test(held.summary || ''), `turn off: held, with the warning (${held.summary})`);
  assert((await one(sql`SELECT notification_prefs FROM users WHERE id = ${A.uid}`)).notification_prefs.accountability !== false, 'nothing changed before approval');
  const row = await one(sql`SELECT id, session_id, tool, args, summary FROM ivy_pending_actions WHERE id = ${held.pending_id}`);
  await executePendingAction({ row, workspaceId: A.ws, userId: A.uid });
  assert((await one(sql`SELECT notification_prefs FROM users WHERE id = ${A.uid}`)).notification_prefs.accountability === false, 'approved: partner off');
  const same = await executeIvyTool('accountability_partner', { action: 'update', enabled: false }, ctx);
  assert(!same.needs_confirmation && /already/.test(same.error || ''), 'no-op change refused before a card');
  const snz = await executeIvyTool('accountability_partner', { action: 'snooze' }, ctx);
  assert(snz.needs_confirmation === true, 'snooze is held too');
  const otherCtx = { workspaceId: B.ws, userId: B.uid };
  const gotB = await executeIvyTool('accountability_partner', { action: 'get' }, otherCtx);
  assert(gotB.enabled === true, "B's Ivy reads B's own settings (A turned theirs off)");

  console.log('\n[11] dashboard: old fields kept, new ones added');
  res = mkRes();
  await dashboard({ ...authReq(A.uid), url: '/dashboard' }, res);
  const d = res.body;
  for (const k of ['currency', 'week', 'twoStepPrompt', 'switchPrompt', 'firstWin', 'missingEmail', 'streak', 'workflowSuggestion',
    'briefing', 'goals', 'metrics', 'revenueVsExpenses', 'today', 'tasks', 'activity']) {
    assert(k in d, `old field ${k} kept`);
  }
  for (const k of ['mrr', 'clients', 'booked', 'hours']) assert(k in d.metrics, `metrics.${k} kept`);
  assert(d.attention && Array.isArray(d.attention.items) && d.attention.items.length > 0 && typeof d.attention.total === 'number', 'attention list');
  assert(d.keyNumbers && d.keyNumbers.revenue && d.keyNumbers.rebooking && d.money, 'keyNumbers + money');

  console.log('\n[12] key numbers: revenue uses the Finance rules');
  const K = await mkOwner('k', { tz: 'UTC' });
  const inv = (num, status, total, extra) => sql`INSERT INTO invoices (workspace_id, number, client_name, items, status, paid_at, refunded_amount)
    VALUES (${K.ws}, ${num}, 'C', ${JSON.stringify([{ description: 'x', quantity: 1, rate: total }])}::jsonb, ${status}, ${extra.paidAt}, ${extra.refunded || 0})`;
  const thisMonth = (await one(sql`SELECT date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + INTERVAL '1 second' AS t`)).t;
  const lastMonthEarly = (await one(sql`SELECT (date_trunc('month', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 month') AT TIME ZONE 'UTC' + INTERVAL '1 second' AS t`)).t;
  const lastMonthEnd = (await one(sql`SELECT date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - INTERVAL '1 second' AS t`)).t;
  await inv('K1', 'paid', 100, { paidAt: thisMonth });
  await inv('K2', 'paid', 100, { paidAt: thisMonth, refunded: 30 });     // partial refund → 70
  await inv('K3', 'refunded', 200, { paidAt: thisMonth, refunded: 200 }); // fully refunded → 0
  await inv('K4', 'voided', 500, { paidAt: thisMonth });                  // voided → 0
  await inv('K5', 'paid', 50, { paidAt: lastMonthEarly });
  await inv('K6', 'paid', 75, { paidAt: lastMonthEnd });
  await inv('K7', 'sent', 40, { paidAt: null });
  await inv('K8', 'overdue', 60, { paidAt: null });
  const kn = await keyNumbers(K.ws, 'UTC');
  assert(kn.revenue.thisMonth === 170, `this month = 100 + 70 (refunds and voids excluded) (got ${kn.revenue.thisMonth})`);
  assert(kn.revenue.lastMonthTotal === 125, `last month total 125 (got ${kn.revenue.lastMonthTotal})`);
  const nowDay = new Date().getUTCDate();
  if (nowDay > 1) assert(kn.revenue.lastMonthSamePoint === 50, `same point last month: only the early one (got ${kn.revenue.lastMonthSamePoint})`);
  assert(kn.outstanding.count === 2 && kn.outstanding.total === 100 && kn.outstanding.overdueTotal === 60, `outstanding (${JSON.stringify(kn.outstanding)})`);
  const res12 = mkRes();
  await dashboard({ ...authReq(K.uid), url: '/dashboard' }, res12);
  assert(res12.body.metrics.mrr === 170, `metrics.mrr agrees with Finance rules (${res12.body.metrics.mrr})`);
  const N = await mkOwner('fresh', { tz: 'UTC' });
  const kf = await keyNumbers(N.ws, 'UTC');
  assert(kf.revenue.lastMonthSamePoint === null && kf.revenue.changePct === null && kf.rebooking.rate === null && kf.bookingsWeek.lastWeek === null,
    'brand-new business: comparisons are null (Not enough data yet), not 0');

  console.log('\n[13] key numbers: rebooking rate');
  for (let i = 0; i < 5; i++) {
    // eslint-disable-next-line no-await-in-loop
    const c = await mkClient(K, `Reb ${i}`, { ageDays: 100 });
    // eslint-disable-next-line no-await-in-loop
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${K.ws}, ${c}, 'R', 'r@example.com', CURRENT_DATE - 60, 600, 660)`;
    if (i < 3) {
      // eslint-disable-next-line no-await-in-loop
      await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
        VALUES (${K.ws}, ${c}, 'R', 'r@example.com', CURRENT_DATE + 3, 600, 660)`;
    }
  }
  const kr = await keyNumbers(K.ws, 'UTC');
  assert(kr.rebooking.cohort === 5 && kr.rebooking.rebooked === 3 && kr.rebooking.rate === 60, `3 of 5 came back = 60% (${JSON.stringify(kr.rebooking)})`);

  console.log('\n[14] the email renders safely');
  const e = renderPartnerEmail({ kind: 'digest', items: [{ title: '<script>x</script>', detail: '"q"', href: '/messages', phrase: 'p' }], firstName: '<b>K</b>', baseUrl: 'https://app.example' });
  assert(!/<script>/.test(e.html) && /&lt;script&gt;/.test(e.html) && /&lt;b&gt;K/.test(e.html), 'names and titles escaped');
  for (const kind of ['digest', 'away1', 'away2']) {
    const m = composeMessage({ kind, items: [] });
    const m2 = composeMessage({ kind, items: items.slice(0, 4) });
    assert(![m.body, m2.body, m.subject, m2.subject].some((t) => /[–—]/.test(t)), `${kind}: no em or en dashes`);
  }
  assert(QUIET_DAYS === 21, 'quiet = 21 days');
}

async function cleanup() {
  for (const o of created) {
    await sql`DELETE FROM notifications WHERE user_id = ${o.uid}`;
    await sql`DELETE FROM workspaces WHERE id = ${o.ws}`;
    await sql`DELETE FROM users WHERE id = ${o.uid}`;
  }
  await sql`DELETE FROM users WHERE email = ${`${TAG}-helper@example.com`}`;
}

run()
  .catch((err) => { fail++; console.error('crashed:', err); })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup:', e.message));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
