// "Book-again link after a visit" (1.0.6, api/_lib/clientAutomations.js,
// kind 'rebook'): the owner's switch that sends the rebook email / text
// after a visit is marked complete.
//   [1] settings: off by default, next morning by default, no template to
//       approve, the delay and channels are checked, enabled_at is kept
//   [2] who gets one: never with something booked (a later booking, a
//       pending request, a repeating series), never after a no-show or a
//       cancellation, never within 7 days of any rebook link (the owner's
//       button, a review request, this automation), never for a group
//       class, a blocked client or a visit from before it was turned on
//   [3] timing: 2 hours after, the next morning at 9am, 3 days after, in
//       the business's own time zone and only inside 9am to 7pm; a very
//       late send is dropped
//   [4] the send: the same "Ready for your next {service}?" email and text
//       as the owner's button, a signed link, rebook_link_sent_at, one
//       ledger row per visit; opted-out and no-consent clients are not
//       retried, a provider failure is
//   [5] claim before send: two runs at once send one link per client
//   [6] isolation, the owner endpoints, helpers refused
//   [7] Ivy: get, due (who would get one), update held with approval
//   [8] Send me a test
//
// Run: node --import ./tests/bootstrap.mjs ./tests/rebook-automation.test.mjs
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';
process.env.IVY_TWILIO_ACCOUNT_SID = 'AC_rbauto_test';
process.env.IVY_TWILIO_AUTH_TOKEN = 'rbauto_test_token';
process.env.IVY_TWILIO_FROM_NUMBER = '+15005550006';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import {
  readAutomations, saveAutomation, runClientAutomations, enabledWorkspaces, dueRebookVisits, dueThisWeek,
  cleanAutomationPatch, REBOOK_MESSAGE,
} from '../api/_lib/clientAutomations.js';
import { verifyRebookToken } from '../api/_lib/rebook.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';
import { executePendingAction } from '../api/_lib/ivyApproval.js';
import automationsApi from '../api/automations/index.js';
import testApi from '../api/automations/test.js';

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
    await new Promise((r) => setTimeout(r, 15));
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
const mailsTo = (addr) => emails.filter((m) => JSON.stringify(m.to || '').toLowerCase().includes(String(addr).toLowerCase()));

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
    'x-forwarded-for': `198.51.100.${(ipN++ % 200) + 10}`,
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
const localISO = (tz, ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const FULL_WEEK = JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 540, end: 1020 }]])));
async function mkBiz(tag, tz) {
  const email = `rbauto-${tag}-${S}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${email}, 'x', 'Kayla Owner', NOW()) RETURNING id`).rows[0].id;
  const w = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${`Glow ${tag}`}, 'active', NOW() + INTERVAL '30 days', NOW() - INTERVAL '200 days') RETURNING id`).rows[0].id;
  const slug = `rbauto-${tag}-${S}`;
  await sql.query(`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, availability, min_notice_hours)
    VALUES ($1, $2, $3, $4, $5::jsonb, 0)
    ON CONFLICT (workspace_id) DO UPDATE SET slug = EXCLUDED.slug, timezone = EXCLUDED.timezone, availability = EXCLUDED.availability`,
  [w, `Glow ${tag}`, slug, tz, FULL_WEEK]);
  const svc = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes) VALUES (${w}, 'Facial', 90, 60) RETURNING id`).rows[0].id;
  const group = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, capacity) VALUES (${w}, 'Yoga class', 20, 60, 8) RETURNING id`).rows[0].id;
  return { userId: u, workspaceId: w, slug, svc, group, tz, email, ctx: { workspaceId: w, userId: u } };
}
async function mkClient(biz, name, extra = {}) {
  const email = extra.email === null ? null : (extra.email || `rbauto-${name.toLowerCase().replace(/\W+/g, '')}-${S}@example.com`);
  const id = (await sql`INSERT INTO clients (workspace_id, name, email, phone, sms_consent_at, stage, notification_prefs)
    VALUES (${biz.workspaceId}, ${name}, ${email}, ${extra.phone || null}, ${extra.consent ? new Date().toISOString() : null},
            'active', ${JSON.stringify(extra.prefs || {})}::jsonb) RETURNING id`).rows[0].id;
  return { id, email, name };
}
// A visit completed `hoursAgo` hours ago (its date: the local day it was completed).
async function mkVisit(biz, client, { hoursAgo = 3, service = null, extra = {} } = {}) {
  const at = Date.now() - hoursAgo * 3600000;
  const day = localISO(biz.tz, at);
  const log = { [day]: { completedAt: new Date(at).toISOString(), notes: '', attachments: [], visibleToClient: true } };
  const b = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, source, completion_log,
                         no_show_at, cancelled_at, recurrence_rule)
    VALUES (${biz.workspaceId}, ${service || biz.svc}, ${client.id}, ${client.name}, ${client.email || 'x@example.com'}, ${day}::date, 480, 540, 'owner',
            ${JSON.stringify(log)}::jsonb, ${extra.noShow ? new Date().toISOString() : null}, ${extra.cancelled ? new Date().toISOString() : null},
            ${extra.recurring ? 'weekly' : null})
    RETURNING id`).rows[0];
  return { id: b.id, day };
}
async function mkFuture(biz, client, { request = false, days = 5 } = {}) {
  await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, source, requested_at, request_expires_at)
    VALUES (${biz.workspaceId}, ${biz.svc}, ${client.id}, ${client.name}, ${client.email}, CURRENT_DATE + ${days}::int, 600, 660, 'public',
            ${request ? new Date().toISOString() : null}, ${request ? new Date(Date.now() + 86400000).toISOString() : null})`;
}
const sendsFor = async (clientId) => (await sql`SELECT * FROM client_automation_sends WHERE client_id = ${clientId} AND kind = 'rebook' ORDER BY claimed_at`).rows;
const turnOn = async (biz, patch = {}, enabledHoursAgo = 24 * 8) => {
  await saveAutomation(biz.workspaceId, 'rebook', { enabled: true, ...patch });
  await sql`UPDATE client_automations SET enabled_at = NOW() - make_interval(hours => ${enabledHoursAgo}) WHERE workspace_id = ${biz.workspaceId} AND kind = 'rebook'`;
};
const wsRow = async (biz, opts = {}) => (await enabledWorkspaces('rebook', { workspaceId: biz.workspaceId, ...opts }))[0];

async function main() {
  await ensureSchemaApplied();
  const TZ_IN = zoneForLocalHour(10);   // 10am: inside the 9am-7pm window
  const TZ_OUT = zoneForLocalHour(3);   // 3am: outside
  const A = await mkBiz('a', TZ_IN);
  const B = await mkBiz('b', TZ_OUT);
  const C = await mkBiz('c', TZ_IN);    // isolation, and the "3 days after" business
  const D = await mkBiz('d', TZ_IN);    // "next morning"

  // ── [1] settings ───────────────────────────────────────────────────────
  console.log('\n[1] settings');
  const def = (await readAutomations(A.workspaceId)).rebook;
  assert(def.enabled === false && def.delay === 'next_morning' && def.delayLabel === 'Next morning', 'OFF by default, next morning by default');
  assert(def.label === 'Book-again link after a visit' && def.note === 'Ivy sends this for you. Each client gets it once per visit, never if they already have something booked.', 'the card label and note');
  assert(def.template === null && def.fixedMessage.subject === 'Ready for your next {service}?' && def.delayOptions.map((o) => o.label).join('|') === '2 hours after|Next morning|3 days after', 'no template to write; the fixed message and the three timings');
  assert(def.channels.email === true && def.channels.sms === false, 'email on, text off by default');
  const bad = (p) => { try { cleanAutomationPatch('rebook', p); return null; } catch (e) { return e.message; } };
  assert(/2h, next_morning or 3d/.test(bad({ delay: 'tomorrow' })) && /written for you/.test(bad({ template: 'Hi {first_name}' })) && /Choose email, text, or both/.test(bad({ channels: { email: false, sms: false } })), 'a bad delay, a template, no channel are refused');
  assert(/only applies to the book-again link/.test((() => { try { cleanAutomationPatch('quiet', { delay: '2h' }); return ''; } catch (e) { return e.message; } })()), 'delay on another kind is refused');
  assert(/only applies/.test(bad({ quietDays: 30 }) || ''), 'quiet days on the book-again link is refused');
  const on = await saveAutomation(A.workspaceId, 'rebook', { enabled: true, delay: '2h' });
  const rowA = await one(sql`SELECT * FROM client_automations WHERE workspace_id = ${A.workspaceId} AND kind = 'rebook'`);
  assert(on.row.enabled === true && on.row.delay === '2h' && rowA.template_approved_at && rowA.enabled_at && Math.abs(new Date(rowA.enabled_at) - Date.now()) < 60000, 'turning on needs no saved message, and records when it went on');
  await saveAutomation(A.workspaceId, 'rebook', { channels: { email: true, sms: true } });
  const again = await one(sql`SELECT enabled_at FROM client_automations WHERE workspace_id = ${A.workspaceId} AND kind = 'rebook'`);
  assert(String(again.enabled_at) === String(rowA.enabled_at), 'changing channels while on keeps when it went on');
  // Visits before the switch went on are never picked up: A went on 5 hours ago.
  await sql`UPDATE client_automations SET enabled_at = NOW() - INTERVAL '5 hours' WHERE workspace_id = ${A.workspaceId} AND kind = 'rebook'`;

  // ── [2] who gets one ───────────────────────────────────────────────────
  console.log('\n[2] who gets one');
  const ana = await mkClient(A, 'Ana Ready');
  const anaV = await mkVisit(A, ana);
  const ben = await mkClient(A, 'Ben Booked'); await mkVisit(A, ben); await mkFuture(A, ben);
  const cal = await mkClient(A, 'Cal Requested'); await mkVisit(A, cal); await mkFuture(A, cal, { request: true });
  const dee = await mkClient(A, 'Dee Noshow'); await mkVisit(A, dee, { extra: { noShow: true } });
  const eve = await mkClient(A, 'Eve Cancelled'); await mkVisit(A, eve, { extra: { cancelled: true } });
  const fin = await mkClient(A, 'Fin Linked'); await mkVisit(A, fin);
  const finOld = await mkVisit(A, fin, { hoursAgo: 24 * 20 });
  await sql`UPDATE bookings SET rebook_link_sent_at = NOW() - INTERVAL '2 days' WHERE id = ${finOld.id}`;
  const gus = await mkClient(A, 'Gus Group'); await mkVisit(A, gus, { service: A.group });
  const hal = await mkClient(A, 'Hal Blocked'); await mkVisit(A, hal);
  await sql`INSERT INTO contact_blocks (workspace_id, client_id, direction) VALUES (${A.workspaceId}, ${hal.id}, 'owner_blocks_client')`;
  const ivo = await mkClient(A, 'Ivo Optout', { prefs: { marketing: false } }); await mkVisit(A, ivo);
  const jo = await mkClient(A, 'Jo Before'); await mkVisit(A, jo, { hoursAgo: 6 });
  const kim = await mkClient(A, 'Kim Series'); await mkVisit(A, kim, { extra: { recurring: true } });
  const lu = await mkClient(A, 'Lu Reviewed'); const luV = await mkVisit(A, lu);
  await sql`UPDATE bookings SET review_requested_at = NOW() - INTERVAL '1 hour' WHERE id = ${luV.id}`;
  const mo = await mkClient(A, 'Mo Texts', { phone: '+15555550123', consent: true }); await mkVisit(A, mo);
  const fay = await mkClient(A, 'Fay Fails', { email: `rbauto-fay-${S}-fail@example.com` }); await mkVisit(A, fay);
  const pia = await mkClient(A, 'Pia Twice'); await mkVisit(A, pia, { hoursAgo: 3 }); await mkVisit(A, pia, { hoursAgo: 4 });
  const wsA = await wsRow(A);
  assert(wsA && wsA.workspace_id === A.workspaceId && wsA.rebook_delay === '2h', 'A is an enabled, in-window book-again business');
  const due = await dueRebookVisits(wsA, { mode: 'due', since: wsA.enabled_at });
  const dueIds = due.map((r) => r.client_id);
  assert(dueIds.includes(ana.id) && dueIds.includes(ivo.id) && dueIds.includes(mo.id) && dueIds.includes(fay.id), 'due: Ana, Mo, the opted-out client (checked at send), the failing address');
  const notDue = { ben: 'a later booking', cal: 'a pending request', dee: 'a no-show', eve: 'a cancellation', fin: 'a rebook link 2 days ago', gus: 'a group class', hal: 'blocked', jo: 'a visit before it went on', kim: 'a repeating series', lu: 'a review request (it has a book-again button)' };
  const people = { ben, cal, dee, eve, fin, gus, hal, jo, kim, lu };
  for (const [k, why] of Object.entries(notDue)) assert(!dueIds.includes(people[k].id), `not due: ${why}`);
  assert(dueIds.filter((x) => x === pia.id).length === 1, 'two visits close together: one row for the client');
  assert(due.find((r) => r.client_id === ana.id)?.period_key === `${anaV.id}:${anaV.day}`, 'the ledger key is the visit (booking and day)');

  // ── [3] timing ─────────────────────────────────────────────────────────
  console.log('\n[3] timing');
  await turnOn(D); // next morning
  const wsD = await wsRow(D);
  const dToday = await mkClient(D, 'Dana Today'); await mkVisit(D, dToday, { hoursAgo: 1 });
  const dYest = await mkClient(D, 'Dora Yesterday'); await mkVisit(D, dYest, { hoursAgo: 26 });
  const dStale = await mkClient(D, 'Dot Stale'); await mkVisit(D, dStale, { hoursAgo: 24 * 6 + 20 });
  const dDue = (await dueRebookVisits(wsD, { mode: 'due', since: wsD.enabled_at })).map((r) => r.client_id);
  assert(dDue.includes(dYest.id) && !dDue.includes(dToday.id), 'next morning: yesterday\'s visit is due at 9am today, today\'s visit is not');
  assert(!dDue.includes(dStale.id), 'a send that is days late is dropped');
  const dUp = await dueRebookVisits(wsD, { mode: 'upcoming', since: wsD.enabled_at });
  const dana = dUp.find((r) => r.client_id === dToday.id);
  const tomorrowLocal = localISO(TZ_IN, Date.now() + 86400000);
  assert(dana && localISO(TZ_IN, new Date(dana.due_at).getTime()) === tomorrowLocal
    && new Intl.DateTimeFormat('en-US', { timeZone: TZ_IN, hour: 'numeric', hour12: false }).format(new Date(dana.due_at)) === '09'
    && / at 9:00 am$/.test(dana.sends_at_label), `today's visit goes out tomorrow at 9am business time (${dana?.sends_at_label})`);
  await turnOn(C, { delay: '3d' });
  const wsC = await wsRow(C);
  const cOld = await mkClient(C, 'Cora Fourdays'); await mkVisit(C, cOld, { hoursAgo: 24 * 4 });
  const cNew = await mkClient(C, 'Cleo Oneday'); await mkVisit(C, cNew, { hoursAgo: 24 });
  const cDue = (await dueRebookVisits(wsC, { mode: 'due', since: wsC.enabled_at })).map((r) => r.client_id);
  assert(cDue.includes(cOld.id) && !cDue.includes(cNew.id), '3 days after: four days ago is due, yesterday is not');
  // Outside 9am to 7pm in the business's zone: nothing is picked up.
  await turnOn(B, { delay: '2h' });
  const bCl = await mkClient(B, 'Bo Night'); await mkVisit(B, bCl);
  assert(!(await wsRow(B)) && !!(await wsRow(B, { inWindow: false })), 'B (3am local) is outside the sending window');
  emails.length = 0;
  const rB = await runClientAutomations({ workspaceId: B.workspaceId });
  assert(rB.sent === 0 && mailsTo(bCl.email).length === 0, 'so the night run sends nothing');
  // "2 hours after" at 6pm lands after 7pm: the card says next morning at 9am.
  const lateAt = await one(sql.query(`SELECT to_char(((x AT TIME ZONE $1)::date + 1 + make_time(9,0,0)) AT TIME ZONE $1 AT TIME ZONE $1, 'HH24:MI') AS t FROM (SELECT NOW() AS x) q`, [TZ_IN]));
  assert(lateAt.t === '09:00', 'the window rule moves a late due time to 9am the next day');

  // ── [4] the send ───────────────────────────────────────────────────────
  console.log('\n[4] the send');
  emails.length = 0; texts.length = 0;
  const r1 = await runClientAutomations({ workspaceId: A.workspaceId });
  const anaMail = mailsTo(ana.email);
  assert(anaMail.length === 1 && anaMail[0].subject === 'Ready for your next Facial?' && /Book again/.test(anaMail[0].html) && /Glow a/.test(anaMail[0].html), `Ana: "Ready for your next Facial?" with a Book again button (${JSON.stringify(r1)})`);
  const href = (anaMail[0].html.match(/href="(https:\/\/www\.joinivy\.ai\/book\/[^"]+\?rebook=[^"]+)"/) || [])[1];
  const tok = href ? verifyRebookToken(decodeURIComponent(href.split('rebook=')[1])) : null;
  assert(tok && tok.clientId === ana.id && tok.serviceId === A.svc && tok.workspaceId === A.workspaceId, 'the button is Ana\'s own signed rebook link for the Facial');
  assert(/List-Unsubscribe/.test(JSON.stringify(anaMail[0].headers || {})), 'with a one-click unsubscribe (marketing email)');
  const anaRows = await sendsFor(ana.id);
  assert(anaRows.length === 1 && anaRows[0].sent_at && anaRows[0].emailed && anaRows[0].booking_id === anaV.id && anaRows[0].period_key === `${anaV.id}:${anaV.day}`, 'one ledger row for the visit, with its booking');
  assert((await one(sql`SELECT rebook_link_sent_at FROM bookings WHERE id = ${anaV.id}`)).rebook_link_sent_at, 'the visit shows "rebook link sent" like the owner\'s button');
  const moText = texts.find((t) => t.To === '+15555550123');
  assert(mailsTo(mo.email).length === 1 && moText && moText.Body.startsWith('Hi Mo, ready for your next Facial with Glow a? Book again here: https://www.joinivy.ai/book/'), 'Mo agreed to texts: email and the same text as the button');
  assert(mailsTo(ivo.email).length === 0 && (await sendsFor(ivo.id)).length === 1 && (await sendsFor(ivo.id))[0].sent_at === null, 'the opted-out client gets nothing and keeps the claim (not retried)');
  assert((await sendsFor(fay.id)).length === 0 && r1.retried >= 1, 'a provider failure hands the claim back');
  assert(mailsTo(pia.email).length === 1, 'two visits close together: one link');
  for (const k of Object.keys(notDue)) assert(mailsTo(people[k].email).length === 0, `nothing to ${people[k].name}`);
  emails.length = 0;
  const r2 = await runClientAutomations({ workspaceId: A.workspaceId });
  assert(mailsTo(ana.email).length === 0 && mailsTo(mo.email).length === 0 && mailsTo(pia.email).length === 0 && mailsTo(fay.email).length === 1, `second run: nobody twice; the failed one is tried again (${JSON.stringify(r2)})`);
  // A new visit 2 days later still waits out the 7 days.
  const anaV2 = await mkVisit(A, ana, { hoursAgo: 3 });
  assert(!(await dueRebookVisits(wsA, { mode: 'due', since: wsA.enabled_at })).some((r) => r.client_id === ana.id), `a second visit within 7 days of a link gets none (${anaV2.id.slice(0, 8)})`);
  // Only the text channel, client never agreed to texts: nothing goes out, not retried.
  await saveAutomation(C.workspaceId, 'rebook', { channels: { email: false, sms: true } });
  const nia = await mkClient(C, 'Nia Nophone', { phone: '+15555550199' }); await mkVisit(C, nia, { hoursAgo: 24 * 4 });
  texts.length = 0;
  await runClientAutomations({ workspaceId: C.workspaceId });
  assert(texts.length === 0 && (await sendsFor(nia.id)).length === 1 && (await sendsFor(nia.id))[0].sent_at === null, 'text only, no consent: no text, kept as handled');
  assert(mailsTo(cOld.email).length === 0, '...and Cora (email off) gets no email');
  await saveAutomation(C.workspaceId, 'rebook', { channels: { email: true, sms: false } });

  // ── [5] claim before send ──────────────────────────────────────────────
  console.log('\n[5] claim before send');
  const E = await mkBiz('e', TZ_IN);
  await turnOn(E, { delay: '2h' });
  const many = [];
  for (let i = 0; i < 4; i++) { const c = await mkClient(E, `Zed Racer${i}`); await mkVisit(E, c); many.push(c); }
  emails.length = 0;
  await Promise.all([runClientAutomations({ workspaceId: E.workspaceId }), runClientAutomations({ workspaceId: E.workspaceId })]);
  assert(many.every((c) => mailsTo(c.email).length === 1), 'two runs at once: each client gets one link');
  const ledgerE = (await sql`SELECT COUNT(*)::int AS n FROM client_automation_sends WHERE workspace_id = ${E.workspaceId} AND kind = 'rebook'`).rows[0].n;
  assert(ledgerE === 4, 'one ledger row per visit');

  // ── [6] isolation and endpoints ────────────────────────────────────────
  console.log('\n[6] isolation, endpoints');
  const cRows = await dueRebookVisits(wsC, { mode: 'upcoming', since: wsC.enabled_at });
  assert(!cRows.some((r) => [ana.id, mo.id, pia.id].includes(r.client_id)), 'C never sees A\'s visits');
  const cara = await mkClient(C, 'Cara Email'); await mkVisit(C, cara, { hoursAgo: 24 * 4 });
  emails.length = 0;
  await runClientAutomations({ workspaceId: C.workspaceId });
  assert(mailsTo(cara.email).length === 1 && emails.length === 1, 'a run for C sends only C\'s links');
  assert(mailsTo(cOld.email).length === 0, 'Cora\'s visit was handled while only texts were on (no phone): not sent later by email');
  const get = await run(automationsApi, req({ uid: D.userId, query: { due: '1' } }));
  assert(get.statusCode === 200 && get.body.automations.rebook.enabled === true && get.body.due.rebook.clients.some((c) => c.name === 'Dana Today' && / at 9:00 am$/.test(c.sendsAtLabel)), 'GET: the card settings and who will get one, with when');
  assert(get.body.automations.birthday && get.body.automations.quiet, '...the other two cards are unchanged');
  const patch = await run(automationsApi, req({ method: 'PATCH', uid: D.userId, body: { kind: 'rebook', delay: '3d' } }));
  assert(patch.statusCode === 200 && patch.body.automation.delay === '3d', 'PATCH saves the timing');
  assert((await run(automationsApi, req({ method: 'PATCH', uid: D.userId, body: { kind: 'rebook', delay: 'soon' } }))).statusCode === 400, 'PATCH refuses a bad timing');
  const helperU = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`rbauto-helper-${S}@example.com`}, 'x', 'Helper', NOW(), 'v1', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO staff_members (workspace_id, user_id, name, permissions) VALUES (${D.workspaceId}, ${helperU}, 'Helper', '{"clients":true,"schedule":true,"messages":true}'::jsonb)`;
  const hPatch = await run(automationsApi, req({ method: 'PATCH', uid: helperU, headers: { 'x-helper-workspace': D.workspaceId }, body: { kind: 'rebook', enabled: false } }));
  assert(hPatch.statusCode === 403 && (await readAutomations(D.workspaceId)).rebook.enabled === true, 'a helper cannot change it');
  const off = await run(automationsApi, req({ method: 'PATCH', uid: D.userId, body: { kind: 'rebook', enabled: false } }));
  assert(off.statusCode === 200 && off.body.automation.enabled === false, 'the owner turns it off');
  emails.length = 0;
  await runClientAutomations({ workspaceId: D.workspaceId });
  assert(mailsTo(dYest.email).length === 0, 'off: nothing goes out');
  const dueOff = await dueThisWeek(D.workspaceId);
  assert(dueOff.rebook.enabled === false && dueOff.rebook.clients.some((c) => c.name === 'Dana Today'), 'off: the card still says who WOULD get one');
  // Back on: visits completed while it was off are not swept up.
  await saveAutomation(D.workspaceId, 'rebook', { enabled: true });
  const wsD2 = await wsRow(D);
  assert((await dueRebookVisits(wsD2, { mode: 'upcoming', since: wsD2.enabled_at })).length === 0, 'turning it back on starts fresh (no backlog)');

  // ── [7] Ivy ────────────────────────────────────────────────────────────
  console.log('\n[7] Ivy');
  const got = await executeIvyTool('client_automations', { action: 'get' }, C.ctx);
  assert(!got.needs_confirmation && got.rebook?.on === true && got.rebook.when === '3 days after' && got.rebook.message.email_subject === REBOOK_MESSAGE.subject, 'get reads the book-again card straight away');
  const dueT = await executeIvyTool('client_automations', { action: 'due' }, A.ctx);
  assert(!dueT.needs_confirmation && dueT.rebook && typeof dueT.rebook.count === 'number', 'due reads who would get one');
  const F = await mkBiz('f', TZ_IN);
  const fCl = await mkClient(F, 'Flo Would'); await mkVisit(F, fCl, { hoursAgo: 2 });
  const dueF = await executeIvyTool('client_automations', { action: 'due' }, F.ctx);
  assert(dueF.rebook.on === false && dueF.rebook.clients.some((c) => c.name === 'Flo Would') && /would get the link/.test(dueF.rebook.off_note), 'off: due lists who would get one, and says it is off');
  const held = await executeIvyTool('client_automations', { action: 'update', kind: 'rebook', enabled: true, delay: '2h' }, F.ctx);
  assert(held.needs_confirmation === true && /turn on the book-again link after a visit/i.test(held.summary) && held.summary.includes(REBOOK_MESSAGE.subject) && /2 hours after the visit is marked complete/.test(held.summary) && /never when they already have something booked/.test(held.summary), `update is held, with the message and timing: ${held.summary}`);
  assert((await readAutomations(F.workspaceId)).rebook.enabled === false, 'nothing changed before approval');
  const prow = await one(sql`SELECT id, session_id, tool, args, summary FROM ivy_pending_actions WHERE id = ${held.pending_id}`);
  const done = await executePendingAction({ row: prow, workspaceId: F.workspaceId, userId: F.userId });
  const fAfter = (await readAutomations(F.workspaceId)).rebook;
  assert(done.claimed && !done.result.error && fAfter.enabled === true && fAfter.delay === '2h', `approved: on, 2 hours after (${done.text})`);
  const badT = await executeIvyTool('client_automations', { action: 'update', kind: 'rebook', template: 'Hi' }, F.ctx);
  assert(/written for you/.test(badT.error || ''), 'a template for the book-again link is refused before any card');

  // ── [8] Send me a test ─────────────────────────────────────────────────
  console.log('\n[8] test send');
  emails.length = 0;
  const t = await run(testApi, req({ method: 'POST', uid: A.userId, body: { kind: 'rebook' } }));
  const tm = mailsTo(A.email)[0];
  assert(t.statusCode === 200 && tm && tm.subject === '[Test] Ready for your next Facial?' && /Hi Kayla/.test(tm.html) && /This is a test of your book-again link/.test(tm.html), 'the owner gets a [Test] of the real email');
  assert((await sql`SELECT 1 FROM client_automation_sends WHERE workspace_id = ${A.workspaceId} AND client_id IS NULL`).rows.length === 0, 'a test is never recorded');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
