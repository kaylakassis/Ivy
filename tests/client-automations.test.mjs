// Client automations (1.0.6, api/_lib/clientAutomations.js): the birthday
// message and "we'd love to see you again".
//   [1] settings: off by default, the template must be saved (approved)
//       before the switch goes on, merge fields and lengths are checked
//   [2] birthday: today in the owner's zone, once per year, leads / demo /
//       blocked / tomorrow excluded, an opted-out client gets nothing and
//       is not retried, a provider failure hands the claim back
//   [3] the owner's time zone window (9am to 7pm local)
//   [4] quiet: the SAME rule as the accountability partner, plus the
//       exclusions (lead, future booking, recent message, recent workflow
//       email, recent review request, another automated message within 7
//       days), once per 90 days, with the rebook link
//   [5] claim before send: two runs at once send once
//   [6] text channel with consent
//   [7] isolation between businesses; the owner endpoints
//   [8] Ivy: get and due read, update held with the full message
//   [9] "Send me a test" and the cron handler
//
// Run: node --import ./tests/bootstrap.mjs ./tests/client-automations.test.mjs
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';
process.env.IVY_TWILIO_ACCOUNT_SID = 'AC_auto_test';
process.env.IVY_TWILIO_AUTH_TOKEN = 'auto_test_token';
process.env.IVY_TWILIO_FROM_NUMBER = '+15005550006';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import {
  readAutomations, saveAutomation, templateProblems, renderTemplate, runClientAutomations, enabledWorkspaces,
  dueBirthdayClients, dueQuietClients, dueThisWeek, DEFAULT_TEMPLATES, QUIET_REPEAT_DAYS,
} from '../api/_lib/clientAutomations.js';
import { quietClients, QUIET_DAYS } from '../api/_lib/accountability.js';
import { executeIvyTool, ledgerEntry } from '../api/_lib/ivyTools.js';
import { executePendingAction } from '../api/_lib/ivyApproval.js';
import automationsApi from '../api/automations/index.js';
import testApi from '../api/automations/test.js';
import cron from '../api/cron/client-automations.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const emails = [];
const texts = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('resend.com')) {
    let m = {};
    try { m = JSON.parse(init.body); } catch { /* not JSON */ }
    emails.push(m);
    await new Promise((r) => setTimeout(r, 20));
    if (JSON.stringify(m.to || '').includes('-fail@')) {
      return new Response(JSON.stringify({ message: 'provider down' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('api.twilio.com')) {
    texts.push(Object.fromEntries(new URLSearchParams(String(init.body || ''))));
    return new Response(JSON.stringify({ sid: 'SM_test', status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
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
let ipN = 0;
const req = ({ method = 'GET', query = {}, body = null, uid = null, headers = {} }) => ({
  method, url: '/test', query, body,
  headers: {
    host: 'localhost:3001', origin: 'http://localhost:3001', 'content-type': 'application/json',
    'x-forwarded-for': `203.0.113.${(ipN++ % 200) + 10}`,
    ...(uid ? { cookie: `ivy_session=${signSession(uid)}` } : {}), ...headers,
  },
  on() {},
});
const run = async (h, r) => { const res = mkRes(); await h(r, res); return res; };
const one = async (q) => (await q).rows[0];

// A DST-free zone whose local hour == targetHour right now.
function zoneForLocalHour(targetHour) {
  const utcH = new Date().getUTCHours();
  let o = ((targetHour - utcH) % 24 + 24) % 24;
  if (o > 14) o -= 24;
  if (o === 0) return 'UTC';
  return o > 0 ? `Etc/GMT-${o}` : `Etc/GMT+${-o}`;
}
function localMonthDay(tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: 'numeric', day: 'numeric' }).formatToParts(new Date())
    .reduce((a, x) => { if (x.type !== 'literal') a[x.type] = Number(x.value); return a; }, {});
  return { month: p.month, day: p.day };
}

const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const FULL_WEEK = JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 540, end: 1020 }]])));
async function mkBiz(tag, tz) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`auto-${tag}-${S}@example.com`}, 'x', 'Kayla Owner', NOW()) RETURNING id`).rows[0].id;
  const w = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`Glow Studio ${tag}`}, 'active', NOW() + INTERVAL '30 days', NOW() - INTERVAL '200 days') RETURNING id`).rows[0].id;
  const slug = `auto-${tag}-${S}`;
  await sql.query(`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, availability, min_notice_hours)
    VALUES ($1, $2, $3, $4, $5::jsonb, 0)
    ON CONFLICT (workspace_id) DO UPDATE SET slug = EXCLUDED.slug, timezone = EXCLUDED.timezone, availability = EXCLUDED.availability`,
  [w, `Glow Studio ${tag}`, slug, tz, FULL_WEEK]);
  const svc = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes) VALUES (${w}, 'Facial', 90, 60) RETURNING id`).rows[0].id;
  return { userId: u, workspaceId: w, slug, svc, tz, email: `auto-${tag}-${S}@example.com`, ctx: { workspaceId: w, userId: u } };
}
async function mkClient(biz, name, extra = {}) {
  const email = extra.email === null ? null : (extra.email || `auto-${name.toLowerCase().replace(/\W+/g, '')}-${S}@example.com`);
  const id = (await sql`INSERT INTO clients (workspace_id, name, email, phone, sms_consent_at, stage, source, birth_month, birth_day, notification_prefs, created_at)
    VALUES (${biz.workspaceId}, ${name}, ${email}, ${extra.phone || null}, ${extra.consent ? new Date().toISOString() : null},
            ${extra.stage || 'active'}, ${extra.source || null}, ${extra.birthMonth || null}, ${extra.birthDay || null},
            ${JSON.stringify(extra.prefs || {})}::jsonb, NOW() - make_interval(days => ${extra.ageDays ?? 100})) RETURNING id`).rows[0].id;
  if (extra.lastBookingDays != null) {
    await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, source)
      VALUES (${biz.workspaceId}, ${biz.svc}, ${id}, ${name}, ${email}, CURRENT_DATE - ${extra.lastBookingDays}::int, 600, 660, 'owner')`;
  }
  return { id, email };
}
const sendsFor = async (clientId, kind) => (await sql`SELECT * FROM client_automation_sends WHERE client_id = ${clientId} AND kind = ${kind} ORDER BY claimed_at`).rows;

async function main() {
  await ensureSchemaApplied();
  const TZ_IN = zoneForLocalHour(10);   // 10am: inside the 9am-7pm window
  const TZ_OUT = zoneForLocalHour(3);   // 3am: outside
  const A = await mkBiz('a', TZ_IN);
  const B = await mkBiz('b', TZ_OUT);
  const C = await mkBiz('c', TZ_IN);    // a second in-window business for isolation
  const bday = localMonthDay(TZ_IN);
  const tomorrow = localMonthDay(TZ_IN); // adjusted below
  const tmr = new Date(Date.now() + 86400000);
  const tmrParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_IN, month: 'numeric', day: 'numeric' }).formatToParts(tmr)
    .reduce((a, x) => { if (x.type !== 'literal') a[x.type] = Number(x.value); return a; }, {});
  tomorrow.month = tmrParts.month; tomorrow.day = tmrParts.day;

  // ── [1] settings ───────────────────────────────────────────────────────
  console.log('\n[1] settings');
  const def = await readAutomations(A.workspaceId);
  assert(def.birthday.enabled === false && def.quiet.enabled === false, 'both OFF by default');
  assert(def.birthday.template === DEFAULT_TEMPLATES.birthday && def.quiet.template === DEFAULT_TEMPLATES.quiet && def.quiet.quietDays === 42, 'default templates and 42 quiet days');
  assert(def.birthday.note === 'Ivy sends this for you. Each client gets it at most once per year.' && def.quiet.note === 'Ivy sends this for you. Each client gets it at most once every 90 days.', 'the visible note per kind');
  await saveAutomation(A.workspaceId, 'birthday', { enabled: true }).then(() => assert(false, 'on without a saved template'), (e) => assert(/Save the message first/.test(e.message), 'turning on before saving the message is refused'));
  assert(/Only \{first_name\}, \{business\} and \{booking_link\}/.test(templateProblems('Hi {name}')), 'an unknown merge field is refused');
  assert(/Plain text only/.test(templateProblems('<b>Hi</b>')) && /under 600/.test(templateProblems('x'.repeat(601))) && templateProblems('   ') && templateProblems(DEFAULT_TEMPLATES.quiet) === null, 'HTML, length and empty are refused; the default passes');
  assert(renderTemplate('Hi {first_name}, {business} {booking_link}', { first_name: 'Bea', business: 'Glow', booking_link: 'https://x' }) === 'Hi Bea, Glow https://x', 'merge fields fill in');
  const saved = await saveAutomation(A.workspaceId, 'birthday', { template: 'Happy birthday, {first_name}! From all of us at {business}.' });
  assert(saved.row.templateApprovedAt && saved.row.enabled === false, 'saving the template approves it (still off)');
  const on = await saveAutomation(A.workspaceId, 'birthday', { enabled: true });
  assert(on.row.enabled === true, 'now it can be turned on');
  await saveAutomation(A.workspaceId, 'quiet', { quietDays: 3 }).then(() => assert(false, 'bad days'), (e) => assert(/7 to 365/.test(e.message), 'quiet days outside 7 to 365 are refused'));
  await saveAutomation(A.workspaceId, 'quiet', { channels: { email: false, sms: false } }).then(() => assert(false, 'no channel'), (e) => assert(/Choose email, text, or both/.test(e.message), 'no channel at all is refused'));
  await saveAutomation(A.workspaceId, 'birthday', { quietDays: 30 }).then(() => assert(false, 'days on birthday'), (e) => assert(/only applies/.test(e.message), 'quiet days on the birthday message is refused'));

  // ── [2] birthday ───────────────────────────────────────────────────────
  console.log('\n[2] birthday');
  const bea = await mkClient(A, 'Bea Today', { birthMonth: bday.month, birthDay: bday.day, lastBookingDays: 60 });
  const lea = await mkClient(A, 'Lea Lead', { birthMonth: bday.month, birthDay: bday.day, stage: 'lead' });
  const noe = await mkClient(A, 'Noe Tomorrow', { birthMonth: tomorrow.month, birthDay: tomorrow.day });
  const demo = await mkClient(A, 'Demo Person', { birthMonth: bday.month, birthDay: bday.day, source: 'demo' });
  const blocked = await mkClient(A, 'Blo Blocked', { birthMonth: bday.month, birthDay: bday.day });
  await sql`INSERT INTO contact_blocks (workspace_id, client_id, direction) VALUES (${A.workspaceId}, ${blocked.id}, 'owner_blocks_client')`;
  const opt = await mkClient(A, 'Opt Out', { birthMonth: bday.month, birthDay: bday.day, prefs: { marketing: false } });
  const fay = await mkClient(A, 'Fay Fails', { birthMonth: bday.month, birthDay: bday.day, email: `auto-fay-fail@example.com` });
  const noContact = await mkClient(A, 'Nina Nothing', { birthMonth: bday.month, birthDay: bday.day, email: null });
  const wsA = (await enabledWorkspaces('birthday', { workspaceId: A.workspaceId }))[0];
  assert(wsA && wsA.workspace_id === A.workspaceId, 'A is an enabled, in-window birthday business');
  const dueB = (await dueBirthdayClients(wsA)).map((r) => r.client_id);
  assert(dueB.includes(bea.id) && dueB.includes(opt.id) && dueB.includes(fay.id), 'due today: Bea, the opted-out client (checked at send), the failing address');
  assert(!dueB.includes(lea.id) && !dueB.includes(noe.id) && !dueB.includes(demo.id) && !dueB.includes(blocked.id) && !dueB.includes(noContact.id), 'not due: a lead, tomorrow\'s birthday, sample data, a blocked client, no way to reach');
  emails.length = 0;
  const r1 = await runClientAutomations({ workspaceId: A.workspaceId });
  assert(r1.sent === 1 && r1.emailed === 1, `first run: one email sent (${JSON.stringify(r1)})`);
  const beaMail = mailsTo(bea.email);
  assert(beaMail.length === 1 && beaMail[0].subject === 'Happy birthday, Bea!' && /From all of us at Glow Studio a/.test(beaMail[0].html), 'Bea: "Happy birthday, Bea!" with the owner\'s words and business name');
  assert(/List-Unsubscribe/.test(JSON.stringify(beaMail[0].headers || {})), 'with a one-click unsubscribe (type marketing)');
  assert(mailsTo(opt.email).length === 0, 'the opted-out client got nothing');
  const optRows = await sendsFor(opt.id, 'birthday');
  assert(optRows.length === 1 && optRows[0].sent_at === null && optRows[0].emailed === false, '...and keeps her claim: not retried, not nagged');
  assert((await sendsFor(fay.id, 'birthday')).length === 0 && r1.retried === 1, 'a provider failure hands the claim back for a later run');
  emails.length = 0;
  const r2 = await runClientAutomations({ workspaceId: A.workspaceId });
  assert(mailsTo(bea.email).length === 0 && r2.sent === 0 && r2.retried === 1 && mailsTo(fay.email).length === 1, 'second run: Bea not again this year; the failed one is tried again (and handed back again)');
  const beaRows = await sendsFor(bea.id, 'birthday');
  assert(beaRows.length === 1 && beaRows[0].period_key === String(new Date().getUTCFullYear()).slice(0, 2) + beaRows[0].period_key.slice(2) && beaRows[0].sent_at && beaRows[0].emailed, 'one ledger row for Bea, keyed on the year');
  // Last year's send does not block this year's.
  await sql`UPDATE client_automation_sends SET period_key = (period_key::int - 1)::text, claimed_at = NOW() - INTERVAL '365 days', sent_at = NOW() - INTERVAL '365 days' WHERE client_id = ${bea.id}`;
  assert((await dueBirthdayClients(wsA)).some((r) => r.client_id === bea.id), 'a send last year leaves Bea due again this year');
  await sql`UPDATE client_automation_sends SET period_key = (period_key::int + 1)::text, claimed_at = NOW(), sent_at = NOW() WHERE client_id = ${bea.id}`;

  // ── [3] time zone window ───────────────────────────────────────────────
  console.log('\n[3] owner time zone');
  await saveAutomation(B.workspaceId, 'birthday', { template: DEFAULT_TEMPLATES.birthday, enabled: true });
  const bdayB = localMonthDay(TZ_OUT);
  const bob = await mkClient(B, 'Bob Night', { birthMonth: bdayB.month, birthDay: bdayB.day });
  assert((await enabledWorkspaces('birthday', { workspaceId: B.workspaceId })).length === 0, 'B (3am local) is outside the 9am to 7pm window');
  assert((await enabledWorkspaces('birthday', { workspaceId: B.workspaceId, inWindow: false })).length === 1, '...and would be eligible otherwise');
  emails.length = 0;
  const rB = await runClientAutomations({ workspaceId: B.workspaceId });
  assert(rB.sent === 0 && mailsTo(bob.email).length === 0, 'nothing goes out at 3am in the owner\'s zone');
  const rB2 = await runClientAutomations({ workspaceId: B.workspaceId, inWindow: false });
  assert(rB2.sent === 1 && mailsTo(bob.email).length === 1, 'the same run inside the window sends (Bob\'s birthday is today in B\'s zone)');

  // ── [4] quiet ──────────────────────────────────────────────────────────
  console.log('\n[4] "we\'d love to see you again"');
  const quin = await mkClient(A, 'Quin Quiet', { lastBookingDays: 60 });
  const fut = await mkClient(A, 'Fut Future', { lastBookingDays: 60 });
  await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, date, start_min, end_min, source) VALUES (${A.workspaceId}, ${A.svc}, ${fut.id}, 'Fut', CURRENT_DATE + 5, 600, 660, 'owner')`;
  const leadQ = await mkClient(A, 'Lead Quiet', { lastBookingDays: 60, stage: 'lead' });
  const recent = await mkClient(A, 'Rec Recent', { lastBookingDays: 10 });
  const msg = await mkClient(A, 'Mes Messaged', { lastBookingDays: 60 });
  const th = await sql`INSERT INTO message_threads (workspace_id, client_id) VALUES (${A.workspaceId}, ${msg.id}) RETURNING id`;
  await sql`INSERT INTO messages (thread_id, sender, text, created_at) VALUES (${th.rows[0].id}, 'biz', 'hi', NOW() - INTERVAL '5 days')`;
  const wf = await mkClient(A, 'Wor Workflowed', { lastBookingDays: 60 });
  const wfRow = await sql`INSERT INTO workflows (workspace_id, name, trigger_type, actions) VALUES (${A.workspaceId}, 'x', 'client_inactive', '[]'::jsonb) RETURNING id`;
  await sql`INSERT INTO workflow_runs (workflow_id, workspace_id, client_id, status, action_results, triggered_at)
    VALUES (${wfRow.rows[0].id}, ${A.workspaceId}, ${wf.id}, 'succeeded', '[{"type":"send_email","status":"ok"}]'::jsonb, NOW() - INTERVAL '3 days')`;
  const rev = await mkClient(A, 'Rev Reviewed', { lastBookingDays: 60 });
  await sql`UPDATE bookings SET review_requested_at = NOW() - INTERVAL '2 days' WHERE client_id = ${rev.id}`;
  const young = await mkClient(A, 'You Young', { ageDays: 10 });
  const optQ = await mkClient(A, 'Opq Optout', { lastBookingDays: 60, prefs: { marketing: false } });
  // Bea got the birthday message today: no check-in within 7 days of it.
  const wsQ = { workspace_id: A.workspaceId, tz: TZ_IN, quiet_days: QUIET_DAYS };
  const dueQ = (await dueQuietClients(wsQ)).map((r) => r.client_id);
  assert(dueQ.includes(quin.id) && dueQ.includes(optQ.id), 'due: the quiet client (the opt-out is checked at send)');
  assert(!dueQ.includes(fut.id), 'not due: a booking coming up');
  assert(!dueQ.includes(leadQ.id), 'not due: a lead');
  assert(!dueQ.includes(recent.id) && !dueQ.includes(young.id), 'not due: seen recently, or new to the business');
  assert(!dueQ.includes(msg.id), 'not due: a message in the last 21 days');
  assert(!dueQ.includes(wf.id), 'not due: a workflow email 3 days ago');
  assert(!dueQ.includes(rev.id), 'not due: a review request 2 days ago');
  assert(!dueQ.includes(bea.id), 'not due: the birthday message went today (7-day gap between automated messages)');
  // Same rule as the partner: every quiet client the partner lists (minus
  // the extra exclusions) is due, and nobody the partner does not list is.
  const partner = (await quietClients(A.workspaceId, { limit: 50 })).clients.map((c) => c.id);
  // (the partner lists blocked and unreachable clients too: it tells the
  // owner, it does not write to them)
  const extraExcluded = new Set([wf.id, rev.id, bea.id, opt.id, blocked.id, noContact.id]); // opt: a birthday claim today counts as an automated message
  assert(partner.includes(quin.id) && partner.includes(fut.id) === false && partner.includes(leadQ.id) === false && partner.includes(msg.id) === false, 'the partner\'s own quiet list agrees on the shared rule');
  {
    const names = async (ids) => (await sql`SELECT name FROM clients WHERE id = ANY(${ids}::uuid[])`).rows.map((r) => r.name);
    const onlyDue = dueQ.filter((id) => !partner.includes(id));
    const onlyPartner = partner.filter((id) => !extraExcluded.has(id) && !dueQ.includes(id));
    if (onlyDue.length || onlyPartner.length) console.log('    only in check-in:', await names(onlyDue), 'only in partner:', await names(onlyPartner));
    assert(!onlyDue.length && !onlyPartner.length, 'the check-in list is the partner\'s list minus the recent-automated-message exclusions');
  }
  await saveAutomation(A.workspaceId, 'quiet', { template: DEFAULT_TEMPLATES.quiet, enabled: true, quietDays: QUIET_DAYS });
  emails.length = 0;
  const rq = await runClientAutomations({ workspaceId: A.workspaceId });
  const quinMail = mailsTo(quin.email);
  assert(quinMail.length === 1 && quinMail[0].subject === "We'd love to see you again", 'Quin gets "We\'d love to see you again"');
  assert(quinMail[0].html.includes(`/book/${A.slug}?rebook=`) && /Book a time/.test(quinMail[0].html), 'with her rebook link (she has a past Facial) and a Book a time button');
  assert(mailsTo(optQ.email).length === 0 && (await sendsFor(optQ.id, 'quiet')).length === 1, 'the opted-out quiet client: nothing sent, claim kept');
  assert(rq.sent >= 1 && mailsTo(bea.email).length === 0 && mailsTo(fut.email).length === 0 && mailsTo(leadQ.email).length === 0, 'nobody excluded was written to');
  emails.length = 0;
  await runClientAutomations({ workspaceId: A.workspaceId });
  assert(mailsTo(quin.email).length === 0, 'not again the next day');
  await sql`UPDATE client_automation_sends SET claimed_at = NOW() - make_interval(days => ${QUIET_REPEAT_DAYS + 1}), sent_at = NOW() - make_interval(days => ${QUIET_REPEAT_DAYS + 1}), period_key = 'old' WHERE client_id = ${quin.id} AND kind = 'quiet'`;
  assert((await dueQuietClients(wsQ)).some((r) => r.client_id === quin.id), `due again after ${QUIET_REPEAT_DAYS} days`);
  // The owner's own number of quiet days.
  const dq50 = await dueQuietClients({ ...wsQ, quiet_days: 70 });
  assert(!dq50.some((r) => r.client_id === quin.id), 'with 70 quiet days, a client seen 60 days ago is not quiet yet');

  // ── [5] two runs at once ───────────────────────────────────────────────
  console.log('\n[5] claim before send');
  const cee = await mkClient(C, 'Cee Concurrent', { birthMonth: bday.month, birthDay: bday.day });
  await saveAutomation(C.workspaceId, 'birthday', { template: DEFAULT_TEMPLATES.birthday, enabled: true });
  emails.length = 0;
  const [x1, x2] = await Promise.all([runClientAutomations({ workspaceId: C.workspaceId }), runClientAutomations({ workspaceId: C.workspaceId })]);
  assert(mailsTo(cee.email).length === 1 && x1.sent + x2.sent === 1 && (await sendsFor(cee.id, 'birthday')).length === 1, 'two concurrent runs: exactly one email, one ledger row');

  // ── [6] text channel ───────────────────────────────────────────────────
  console.log('\n[6] text');
  const tex = await mkClient(C, 'Tex Texter', { birthMonth: bday.month, birthDay: bday.day, email: null, phone: '+15551239001', consent: true });
  const noc = await mkClient(C, 'Noc Noconsent', { birthMonth: bday.month, birthDay: bday.day, email: null, phone: '+15551239002' });
  await saveAutomation(C.workspaceId, 'birthday', { channels: { email: true, sms: true } });
  texts.length = 0; emails.length = 0;
  await runClientAutomations({ workspaceId: C.workspaceId });
  assert(texts.length === 1 && texts[0].To === '+15551239001' && /Happy birthday, Tex!/.test(texts[0].Body) && /Reply STOP/.test(texts[0].Body), 'a consenting client is texted the message with the STOP line');
  assert((await sendsFor(noc.id, 'birthday')).length === 0 && !texts.some((t) => t.To === '+15551239002'), 'no consent and no email: not a candidate at all');

  // ── [7] isolation and the owner endpoints ──────────────────────────────
  console.log('\n[7] isolation');
  const dueA = await dueThisWeek(A.workspaceId);
  const dueC = await dueThisWeek(C.workspaceId);
  assert(dueA.birthday.clients.some((c) => c.clientId === noe.id) && !dueA.birthday.clients.some((c) => c.clientId === cee.id), 'A\'s "due this week" lists Noe (tomorrow) and never C\'s clients');
  assert(!dueC.quiet.clients.some((c) => c.clientId === quin.id), 'C\'s quiet list never shows A\'s clients');
  assert((await readAutomations(C.workspaceId)).quiet.enabled === false, 'C\'s quiet setting is its own (off)');
  const get = await run(automationsApi, req({ uid: A.userId, query: { due: '1' } }));
  assert(get.statusCode === 200 && get.body.automations.birthday.enabled && get.body.business === 'Glow Studio a' && get.body.due.birthday.clients.length >= 1, 'GET /api/automations: settings, business name, who is due');
  const patch = await run(automationsApi, req({ method: 'PATCH', uid: A.userId, body: { kind: 'quiet', quietDays: 60 } }));
  assert(patch.statusCode === 200 && patch.body.automation.quietDays === 60, 'PATCH saves quiet days');
  assert((await run(automationsApi, req({ method: 'PATCH', uid: A.userId, body: { kind: 'quiet', template: 'Hi {nope}' } }))).statusCode === 400, 'PATCH refuses a bad template');
  assert((await run(automationsApi, req({ method: 'PATCH', uid: A.userId, body: { kind: 'other', enabled: true } }))).statusCode === 400, 'PATCH refuses an unknown kind');
  assert((await run(automationsApi, req({}))).statusCode === 401, 'signed out is refused');
  const getB = await run(automationsApi, req({ uid: B.userId }));
  assert(getB.statusCode === 200 && getB.body.automations.quiet.enabled === false && getB.body.business === 'Glow Studio b', 'B reads only its own settings');

  // ── [8] Ivy ────────────────────────────────────────────────────────────
  console.log('\n[8] Ivy client_automations');
  const got = await executeIvyTool('client_automations', { action: 'get' }, A.ctx);
  assert(!got.needs_confirmation && got.birthday?.on === true && got.quiet?.quiet_days === 60 && /\/marketing\?tab=workflows/.test(got.manage), 'get reads straight away');
  const dueT = await executeIvyTool('client_automations', { action: 'due' }, A.ctx);
  assert(!dueT.needs_confirmation && dueT.birthday.this_week.some((c) => c.name === 'Noe Tomorrow') && !dueT.quiet.clients.some((c) => c.name === 'Cee Concurrent'), 'due reads who is due this week, for this business only');
  const n0 = (await one(sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId}`)).n;
  const upd = { action: 'update', kind: 'quiet', template: "Hi {first_name}, we miss you at {business}! Book here: {booking_link}", channels: { email: true, sms: false }, quiet_days: 45 };
  const held = await executeIvyTool('client_automations', upd, A.ctx);
  assert(held.needs_confirmation === true && held.summary.includes('"Hi {first_name}, we miss you at {business}! Book here: {booking_link}"') && /count a client as quiet after 45 days/.test(held.summary), `update is held, the card shows the whole message: ${held.summary}`);
  assert((await readAutomations(A.workspaceId)).quiet.quietDays === 60 && (await one(sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId}`)).n === n0 + 1, 'nothing changed before approval');
  assert(ledgerEntry('client_automations', upd, held)?.status === 'waiting', 'ledger: waiting');
  const prow = await one(sql`SELECT id, session_id, tool, args, summary FROM ivy_pending_actions WHERE id = ${held.pending_id}`);
  const done = await executePendingAction({ row: prow, workspaceId: A.workspaceId, userId: A.userId });
  const afterQ = (await readAutomations(A.workspaceId)).quiet;
  assert(done.claimed && !done.result.error && afterQ.quietDays === 45 && /we miss you/.test(afterQ.template), `approved: saved (${done.text})`);
  const bad = await executeIvyTool('client_automations', { action: 'update', kind: 'birthday', template: 'Hi {name}' }, A.ctx);
  assert(/Only \{first_name\}/.test(bad.error || '') && (await one(sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId}`)).n === n0 + 1, 'a bad template is refused before any card');
  const onC = await executeIvyTool('client_automations', { action: 'update', kind: 'quiet', enabled: true }, C.ctx);
  assert(/Save the .* message first/.test(onC.error || ''), 'turning on with no saved message is refused before any card');
  const offHeld = await executeIvyTool('client_automations', { action: 'update', kind: 'birthday', enabled: false }, A.ctx);
  assert(offHeld.needs_confirmation && /Turn off the Birthday message\. Nothing goes out while it is off\./.test(offHeld.summary), 'turning off is held too, with the plain consequence');

  // ── [9] test send and the cron ─────────────────────────────────────────
  console.log('\n[9] test send, cron');
  emails.length = 0;
  const t = await run(testApi, req({ method: 'POST', uid: A.userId, body: { kind: 'birthday', template: 'Hi {first_name} from {business}' } }));
  assert(t.statusCode === 200 && t.body.to === A.email && mailsTo(A.email).length === 1 && /^\[Test\] Happy birthday, Kayla!/.test(emails[0].subject) && /Hi Kayla from Glow Studio a/.test(emails[0].html), 'the owner gets a [Test] with their own name and business');
  assert((await run(testApi, req({ method: 'POST', uid: A.userId, body: { kind: 'quiet', template: 'Hi {x}' } }))).statusCode === 400, 'a bad template cannot be test-sent');
  assert((await sendsFor(A.userId, 'birthday')).length === 0, 'a test is never recorded');
  const unauth = await run(cron, req({ method: 'POST' }));
  assert(unauth.statusCode === 401, 'the cron needs its secret');
  const cr = await run(cron, req({ method: 'POST', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  assert(cr.statusCode === 200 && typeof cr.body.sent === 'number' && cr.body.shards === 1 && ['empty', 'deadline'].includes(cr.body.terminatedBy), `the cron runs: ${JSON.stringify(cr.body)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
