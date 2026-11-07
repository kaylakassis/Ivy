// Admin view of the accountability partner (Admin → Accountability partner).
//   [1] tracking from the real paths: a cron send records its kind and
//       delivery, tags its links, records what it named; a visit marks it
//       opened; a tap on its link marks it clicked (own sends only); the
//       named item is found cleared; snooze, warning kept, turn-offs by
//       route (settings / Ivy / notifications PATCH) are recorded
//   [2] counts are exact on seeded data (scoped to this run's businesses);
//       rates stay hidden below the minimum sample; uncollected days are null
//   [3] super-admin only: 403 for an owner, a client and a helper; 401 signed out
//   [4] no PII in the response
//
// Run: node --import ./tests/bootstrap.mjs ./tests/admin-accountability-partner.test.mjs
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';
process.env.ADMIN_SECRET ||= 'test-admin-secret';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { checkPartnerMentions, mentionCleared, withPartnerRef } from '../api/_lib/accountability.js';
import { partnerStats, MIN_SAMPLE } from '../api/_lib/partnerStats.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';
import { executePendingAction } from '../api/_lib/ivyApproval.js';
const { default: partnerCron } = await import('../api/cron/accountability-partner.js');
const { default: partnerApi } = await import('../api/me/accountability.js');
const { default: notificationsApi } = await import('../api/me/notifications.js');
const { default: adminPartner } = await import('../api/admin/accountability-partner.js');

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
const mkRes = () => ({
  statusCode: 200, headers: {}, body: null,
  status(c) { this.statusCode = c; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  getHeader(k) { return this.headers[k.toLowerCase()]; },
  json(o) { this.body = o; return this; }, send(o) { this.body = o; return this; },
  end(s) { if (s !== undefined) this.body = s; return this; },
});
let ip = 0;
const authReq = (uid, method = 'GET', body = null, url = '/api/me/accountability') => ({
  method, url, query: {},
  headers: {
    host: 'localhost:3001', origin: 'http://localhost:3001', 'user-agent': 'test/1.0', 'x-forwarded-for': `198.51.100.${(ip++ % 200) + 20}`,
    'content-type': 'application/json', ...(uid ? { cookie: `ivy_session=${signSession(uid)}` } : {}),
  },
  body: body == null ? null : JSON.stringify(body), on() {},
});
const cronReq = () => ({ method: 'POST', url: '/api/cron/accountability-partner', query: {}, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
const one = async (q) => (await q).rows[0];

function zoneForLocalHour(targetHour) {
  const utcH = new Date().getUTCHours();
  let o = ((targetHour - utcH) % 24 + 24) % 24;
  if (o > 14) o -= 24;
  if (o === 0) return 'UTC';
  return o > 0 ? `Etc/GMT-${o}` : `Etc/GMT+${-o}`;
}

const TAG = `aap${Date.now()}${Math.floor(Math.random() * 1e4)}`;
async function mkOwner(t, { prefs = {}, aprefs = {}, tester = false, onboarded = true, signupDaysAgo = 40, lastActiveAgo = '1 hour' } = {}) {
  const email = `${TAG}-${t}@example.com`;
  const uid = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at, email_verified_at, notification_prefs, accountability_prefs, is_tester, last_active_at, created_at)
    VALUES (${email}, 'x', ${`Pat ${t} Private`}, '2026-05-05', NOW(), NOW(), ${JSON.stringify(prefs)}::jsonb, ${JSON.stringify(aprefs)}::jsonb, ${tester}, NOW() - ${lastActiveAgo}::interval, NOW() - ${`${signupDaysAgo} days`}::interval)
    RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, 'active', NOW() + INTERVAL '30 days', ${onboarded ? new Date().toISOString() : null}) RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, availability)
    VALUES (${ws}, 'Studio', ${`${TAG}-${t}`}, ${zoneForLocalHour(11)}, '{"mon":[{"start":"09:00","end":"17:00"}]}'::jsonb)`;
  await sql`INSERT INTO services (workspace_id, name, price, duration_minutes) VALUES (${ws}, 'Session', 80, 60)`;
  return { uid, ws, email };
}
const ev = (o, event, extra = {}) => sql`
  INSERT INTO partner_events (workspace_id, user_id, event, kind, source, push_devices, emailed, opened_at, clicked_at, click_channel, created_at)
  VALUES (${o.ws}, ${o.uid}, ${event}, ${extra.kind || null}, ${extra.source || null}, ${extra.push ?? null}, ${extra.emailed ?? null},
          ${extra.opened ? new Date(Date.now() - (extra.ago - 1) * 3600000).toISOString() : null},
          ${extra.clicked ? new Date(Date.now() - (extra.ago - 1) * 3600000).toISOString() : null}, ${extra.channel || null},
          NOW() - ${`${extra.ago || 0} hours`}::interval)`;

async function main() {
  await ensureSchemaApplied();
  const created = [];

  console.log('\n[1] tracking from the real paths');
  const A = await mkOwner('a', { lastActiveAgo: '2 hours' });
  created.push(A);
  const jane = (await sql`INSERT INTO clients (workspace_id, name, email, stage, created_at) VALUES (${A.ws}, 'Jane Doe', ${`${TAG}-jane@example.com`}, 'active', NOW() - INTERVAL '60 days') RETURNING id`).rows[0].id;
  const thread = (await sql`INSERT INTO message_threads (workspace_id, client_id, unread_biz, last_message_at) VALUES (${A.ws}, ${jane}, 1, NOW() - INTERVAL '6 hours') RETURNING id`).rows[0].id;
  await sql`INSERT INTO messages (thread_id, sender, text, created_at) VALUES (${thread}, 'client', 'private words', NOW() - INTERVAL '6 hours')`;
  await partnerCron(cronReq(), mkRes());
  const sent = await one(sql`SELECT * FROM partner_events WHERE workspace_id = ${A.ws} AND event = 'sent'`);
  assert(sent && sent.kind === 'daily' && sent.push_devices === 0 && sent.emailed === true && sent.item_count >= 1, `send recorded: kind ${sent?.kind}, push ${sent?.push_devices}, emailed ${sent?.emailed}`);
  const bell = await one(sql`SELECT url FROM notifications WHERE user_id = ${A.uid} AND type = 'accountability' ORDER BY created_at DESC LIMIT 1`);
  assert(bell && bell.url.includes(`ptr=n.${sent.id}`), `bell/push link tagged (${bell?.url})`);
  const mail = emails.find((m) => JSON.stringify(m.to || '').includes(A.email));
  assert(mail && mail.html.includes(`ptr=e.${sent.id}`) && !mail.html.includes('private words'), 'email links tagged; no message text');
  const mention = await one(sql`SELECT * FROM partner_mentions WHERE event_id = ${sent.id} AND signal_key = 'unread_messages'`);
  assert(mention && mention.item_ids.includes(thread) && !mention.settled, 'what it named is recorded by id');
  assert(withPartnerRef('/dashboard#goals', `n.${sent.id}`) === `/dashboard?ptr=n.${sent.id}#goals` && withPartnerRef('https://x.example', `n.${sent.id}`) === 'https://x.example', 'link tagging keeps hashes, skips outside links');

  // Not cleared yet → stays open; replied → cleared.
  let chk = await checkPartnerMentions({ limit: 2000 });
  assert((await one(sql`SELECT settled, checked_at FROM partner_mentions WHERE id = ${mention.id}`)).checked_at !== null, `checked (${JSON.stringify(chk)})`);
  assert(!(await one(sql`SELECT settled FROM partner_mentions WHERE id = ${mention.id}`)).settled, 'still waiting: not cleared');
  await sql`UPDATE message_threads SET unread_biz = 0 WHERE id = ${thread}`;
  await sql`UPDATE partner_mentions SET checked_at = NULL WHERE id = ${mention.id}`;
  chk = await checkPartnerMentions({ limit: 2000 });
  const m2 = await one(sql`SELECT settled, cleared_at FROM partner_mentions WHERE id = ${mention.id}`);
  assert(m2.settled && m2.cleared_at, 'answered → cleared');
  assert(mentionCleared(['a', 'n5'], { ids: ['b', 'n5'] }) && !mentionCleared(['a'], { ids: ['a'] }) && mentionCleared(['a'], null) && !mentionCleared(['u2'], { ids: ['u3'] }), 'cleared rule: none of the named ids remain, or the item is gone');

  // A visit within 24h marks the send opened (activity stamp path).
  await sql`UPDATE users SET last_active_at = NOW() - INTERVAL '2 hours' WHERE id = ${A.uid}`;
  let res = mkRes(); await partnerApi(authReq(A.uid, 'GET'), res);
  await new Promise((r) => setTimeout(r, 300));
  assert(!!(await one(sql`SELECT opened_at FROM partner_events WHERE id = ${sent.id}`)).opened_at, 'a visit after the message marks it opened');

  // Tap on the link: only the owner's own send.
  const B = await mkOwner('b');
  created.push(B);
  res = mkRes(); await partnerApi(authReq(B.uid, 'POST', { action: 'opened', ref: `e.${sent.id}` }), res);
  assert(res.statusCode === 200 && res.body.marked === false, "another owner cannot mark A's message");
  res = mkRes(); await partnerApi(authReq(A.uid, 'POST', { action: 'opened', ref: `e.${sent.id}` }), res);
  const c = await one(sql`SELECT clicked_at, click_channel FROM partner_events WHERE id = ${sent.id}`);
  assert(res.body.marked === true && c.clicked_at && c.click_channel === 'email', 'own tap recorded with its channel');
  res = mkRes(); await partnerApi(authReq(A.uid, 'POST', { action: 'opened', ref: "e.x' OR 1=1" }), res);
  assert(res.body.marked === false, 'a junk ref marks nothing');

  // Snooze, warning kept, turn-offs by route.
  res = mkRes(); await partnerApi(authReq(B.uid, 'POST', { action: 'snooze' }), res);
  res = mkRes(); await partnerApi(authReq(B.uid, 'POST', { action: 'warning_kept' }), res);
  res = mkRes(); await partnerApi(authReq(B.uid, 'PATCH', { enabled: false }), res);
  assert(res.statusCode === 200 && res.body.enabled === false, 'turned off in settings');
  res = mkRes(); await partnerApi(authReq(B.uid, 'PATCH', { enabled: true }), res);
  const C = await mkOwner('c');
  created.push(C);
  const held = await executeIvyTool('accountability_partner', { action: 'update', enabled: false }, { workspaceId: C.ws, userId: C.uid });
  assert(held.needs_confirmation, 'Ivy turn-off waits for approval');
  const prow = await one(sql`SELECT id, session_id, tool, args, summary FROM ivy_pending_actions WHERE id = ${held.pending_id}`);
  await executePendingAction({ row: prow, workspaceId: C.ws, userId: C.uid });
  const D = await mkOwner('d');
  created.push(D);
  res = mkRes(); await notificationsApi(authReq(D.uid, 'PATCH', { pushPrefs: { accountability: false } }, '/api/me/notifications'), res);
  const evs = (await sql`SELECT pe.event, pe.source, w.id AS ws FROM partner_events pe JOIN workspaces w ON w.id = pe.workspace_id
    WHERE pe.workspace_id = ANY(${[B.ws, C.ws, D.ws]}::uuid[]) ORDER BY pe.created_at`).rows;
  const has = (ws, event, source) => evs.some((e) => e.ws === ws && e.event === event && (source == null || e.source === source));
  assert(has(B.ws, 'snoozed') && has(B.ws, 'warning_kept') && has(B.ws, 'turned_off', 'settings') && has(B.ws, 'turned_on', 'settings'), 'B: snooze, kept, off and on in settings');
  assert(has(C.ws, 'turned_off', 'ivy'), 'C: turned off through Ivy');
  assert(has(D.ws, 'turned_off', 'other'), 'D: turned off without the warning');

  console.log('\n[2] exact counts on seeded data');
  const E = await mkOwner('e', { aprefs: { frequency: 'weekly' }, signupDaysAgo: 3 });
  const F = await mkOwner('f', { prefs: { accountability: false }, signupDaysAgo: 0 });
  const G = await mkOwner('g', { prefs: { email_accountability: false }, aprefs: { frequency: 'important' }, signupDaysAgo: 120 });
  const T = await mkOwner('t', { tester: true });
  const N = await mkOwner('n', { onboarded: false });
  const scope = [E, F, G, T, N].map((o) => o.ws);
  // Sends: 12 daily 30h ago (8 opened, 3 clicked of which 2 by email),
  // 1 daily 1 minute ago (too new for the open rate), 2 weekly 72h ago.
  for (let i = 0; i < 12; i++) {
    await ev(E, 'sent', { kind: 'daily', ago: 30, push: i < 10 ? 1 : 0, emailed: i % 2 === 0, opened: i < 8, clicked: i < 3, channel: i < 2 ? 'email' : (i < 3 ? 'notification' : null) });
  }
  await ev(E, 'sent', { kind: 'daily', ago: 0, push: 2, emailed: false });
  await ev(G, 'sent', { kind: 'weekly', ago: 72, push: 0, emailed: false });
  await ev(G, 'sent', { kind: 'away3', ago: 72, push: 0, emailed: true });
  // A test account's send: the cron never writes to one, but a stored row still counts in sends.
  await ev(T, 'sent', { kind: 'daily', ago: 30, push: 1, emailed: true, opened: true });
  // Snoozes: E twice 3 days ago, G once 20 days ago.
  await ev(E, 'snoozed', { ago: 72 }); await ev(E, 'snoozed', { ago: 72 }); await ev(G, 'snoozed', { ago: 480 });
  // Mentions for E: 12 settled (9 cleared in 48h, 1 at 50h, 2 not), 2 still open.
  const em = (key, { clearedH = null, settled = true, ageH = 60 } = {}) => sql`
    INSERT INTO partner_mentions (workspace_id, signal_key, item_ids, mentioned_at, cleared_at, settled)
    VALUES (${E.ws}, ${key}, '[]'::jsonb, NOW() - ${`${ageH} hours`}::interval,
            ${clearedH == null ? null : new Date(Date.now() - (ageH - clearedH) * 3600000).toISOString()}, ${settled})`;
  for (let i = 0; i < 9; i++) await em('unread_messages', { clearedH: 5 });
  await em('unread_messages', { clearedH: 50 });
  await em('unread_messages'); await em('unread_messages');
  await em('docs_unsent', { settled: false, ageH: 3 }); await em('docs_unsent', { settled: false, ageH: 3 });
  // Turn-offs: F same day (settings), G 100 days after (ivy), plus kept x3.
  await ev(F, 'turned_off', { source: 'settings', ago: 0 });
  await ev(G, 'turned_off', { source: 'ivy', ago: 480 });
  for (let i = 0; i < 3; i++) await ev(E, 'warning_kept', { ago: 24 });

  const s = await partnerStats({ workspaceIds: scope });
  assert(s.reach.eligible === 3, `eligible owners = 3 (tester and not-onboarded left out) (${s.reach.eligible})`);
  assert(s.reach.on === 2 && s.reach.off === 1 && s.reach.offPct === 33.3, `on 2, off 1, 33.3% off (${s.reach.on}/${s.reach.off}/${s.reach.offPct})`);
  assert(s.reach.emailOn === 1 && s.reach.emailOff === 1, 'email on 1, off 1');
  assert(s.reach.frequency.weekly === 1 && s.reach.frequency.important === 1 && s.reach.frequency.daily === 0, `frequency mix (${JSON.stringify(s.reach.frequency)})`);
  assert(s.reach.snoozes.last7.taps === 2 && s.reach.snoozes.last7.owners === 1 && s.reach.snoozes.last30.taps === 3 && s.reach.snoozes.last30.owners === 2, `snoozes 7d 2 by 1, 30d 3 by 2 (${JSON.stringify(s.reach.snoozes)})`);
  assert(s.sends.last30.sent === 16, `sent in 30 days = 16 (${s.sends.last30.sent})`);
  assert(s.sends.last30.pushReached === 12 && s.sends.last30.emailed === 8, `push 12, email 8 (${s.sends.last30.pushReached}/${s.sends.last30.emailed})`);
  assert(s.sends.last30.both === 6 && s.sends.last30.bellOnly === 2, `both 6, bell only 2 (${s.sends.last30.both}/${s.sends.last30.bellOnly})`);
  const dayTotal = s.sends.days.reduce((a, d) => a + (d.daily || 0) + (d.weekly || 0) + (d.away3 || 0) + (d.away7 || 0), 0);
  assert(s.sends.days.length === 30 && dayTotal === 16, `30 days, 16 in total by day (${dayTotal})`);
  assert(s.sends.days.filter((d) => !d.collected).every((d) => d.daily === null), 'days before tracking are null, never zero');
  assert(s.helped.opened.messages === 15 && s.helped.opened.opened === 9 && s.helped.opened.openedPct === 60, `opened: 9 of 15 = 60% (${s.helped.opened.opened}/${s.helped.opened.messages})`);
  assert(s.helped.opened.clicked === 3 && s.helped.opened.clickedPct === 20 && s.helped.opened.clickedFromEmail === 2, 'clicked: 3 of 15 = 20%, 2 from email');
  const daily = s.helped.opened.byKind.find((k) => k.id === 'daily');
  assert(daily.messages === 13 && daily.opened === 9 && daily.openedPct === 69.2, `daily: 9 of 13 (${daily.opened}/${daily.messages})`);
  assert(s.helped.opened.byKind.find((k) => k.id === 'weekly').openedPct === null, 'weekly: too few for a rate');
  const um = s.helped.cleared.bySignal.find((x) => x.key === 'unread_messages');
  assert(um.mentioned === 12 && um.cleared === 9 && um.clearedPct === 75 && um.stillOpen === 0, `unread messages: 9 of 12 cleared in 48h (${um.cleared}/${um.mentioned})`);
  const du = s.helped.cleared.bySignal.find((x) => x.key === 'docs_unsent');
  assert(du.mentioned === 0 && du.stillOpen === 2 && du.clearedPct === null, 'documents: 2 still inside their 48 hours, no rate');
  assert(s.turnOffs.total === 2, `turn-offs 2 (${s.turnOffs.total})`);
  const bySrc = Object.fromEntries(s.turnOffs.bySource.map((x) => [x.source, x]));
  assert(bySrc.settings.count === 1 && bySrc.settings.whenAfterSignup.find((b) => b.id === 'day0').count === 1, 'settings turn-off on sign-up day');
  assert(bySrc.ivy.count === 1 && bySrc.ivy.whenAfterSignup.find((b) => b.id === 'later').count === 1, 'Ivy turn-off 100 days after sign-up');
  assert(bySrc.other.count === 0, 'no turn-off without the warning here');
  assert(s.turnOffs.warning.keptOn === 3 && s.turnOffs.warning.turnedOff === 1 && s.turnOffs.warning.keptPct === null, 'warning: 3 kept, 1 turned off, too few for a rate');
  assert(s.turnOffs.medianDaysAfterSignup === null, `median hidden below ${MIN_SAMPLE} turn-offs`);
  assert(s.trackingSince && new Date(s.trackingSince) < new Date(Date.now() - 400 * 3600000), 'tracking start = the earliest live event');
  const empty = await partnerStats({ workspaceIds: [N.ws] });
  assert(empty.trackingSince === null && empty.sends.days.every((d) => !d.collected && d.daily === null) && empty.helped.opened.openedPct === null, 'nothing tracked: no numbers made up');

  console.log('\n[3] super-admin only');
  const helperUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`${TAG}-helper@example.com`}, 'x', 'Helper', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO staff_members (workspace_id, user_id, name, permissions) VALUES (${E.ws}, ${helperUser}, 'Helper', '{"clients":true}'::jsonb)`;
  const clientUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`${TAG}-client@example.com`}, 'x', 'Client', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO clients (workspace_id, name, email, user_id) VALUES (${E.ws}, 'Client', ${`${TAG}-client@example.com`}, ${clientUser})`;
  for (const [who, uid] of [['owner', E.uid], ['client', clientUser], ['helper', helperUser]]) {
    res = mkRes(); await adminPartner(authReq(uid, 'GET', null, '/api/admin/accountability-partner'), res);
    assert(res.statusCode === 403 && !res.body?.reach, `${who}: 403`);
  }
  res = mkRes(); await adminPartner(authReq(null, 'GET', null, '/api/admin/accountability-partner'), res);
  assert(res.statusCode === 401, `signed out: 401 (${res.statusCode})`);
  res = mkRes(); await adminPartner({ ...authReq(null, 'POST', {}, '/api/admin/accountability-partner'), headers: { ...authReq(null).headers, 'x-admin-secret': process.env.ADMIN_SECRET } }, res);
  assert(res.statusCode === 405, 'read only');
  const admin = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type) VALUES (${`${TAG}-admin@example.com`}, 'x', 'Admin', NOW(), 'super_admin') RETURNING id`).rows[0].id;
  res = mkRes(); await adminPartner(authReq(admin, 'GET', null, '/api/admin/accountability-partner'), res);
  assert(res.statusCode === 200 && res.body.reach && res.body.sends.days.length === 30, 'super-admin: 200 with the numbers');

  console.log('\n[4] no PII');
  const body = JSON.stringify(res.body);
  assert(!/@/.test(body), 'no email addresses');
  assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(body), 'no ids');
  assert(!/Pat |Private|Jane|private words/.test(body), 'no names or message text');
  const scoped = JSON.stringify(s);
  assert(!/@|Pat |Jane/.test(scoped) && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(scoped), 'scoped stats carry no PII either');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
