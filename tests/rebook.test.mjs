// One-tap rebook (1.0.6, api/_lib/rebook.js):
//   [1] the suggestion math: median gap in whole weeks (1 to 12), the
//       service's typical gap when the client has fewer than two visits,
//       4 weeks with no history; same weekday; same time when free, else
//       the nearest free time, else the day alone
//   [2] tokens: forged, expired and another business's are 404s; a valid
//       one answers the service and the day with nothing about the client
//   [3] opt-outs and consent: a muted client gets no email, a client
//       without SMS consent gets no text
//   [4] the owner's "Send rebook link": rate limited, other business 404
//   [5] a booking through the link is marked booked_via = 'rebook' (a token
//       for another business is ignored) and the dashboard counts it
//   [6] the client portal carries the link and "Your usual" only from the
//       client's own visits
//   [7] Ivy's send_rebook_link is held before approval and refuses a client
//       from another business
//
// Run: node --import ./tests/bootstrap.mjs ./tests/rebook.test.mjs
process.env.APP_URL = 'https://www.joinivy.ai';
process.env.IVY_TWILIO_ACCOUNT_SID = 'AC_rebook_test';
process.env.IVY_TWILIO_AUTH_TOKEN = 'rebook_test_token';
process.env.IVY_TWILIO_FROM_NUMBER = '+15005550006';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import {
  cadenceFrom, suggestedDate, candidateStarts, weeksFromGapDays, gapsOf, median,
  mintRebookToken, verifyRebookToken, computeRebookSuggestion, sendRebookLink, usualLine, addDaysISO, weekdayOf,
} from '../api/_lib/rebook.js';
import { keyNumbers } from '../api/_lib/dashboardNumbers.js';
import { executeIvyTool, ledgerEntry } from '../api/_lib/ivyTools.js';
import { executePendingAction } from '../api/_lib/ivyApproval.js';
import publicRebook from '../api/calendar/public/rebook.js';
import slugHandler from '../api/calendar/public/[slug].js';
import rebookLinkApi from '../api/calendar/bookings/rebook-link.js';
import meBookings from '../api/me/bookings.js';
import dashboard from '../api/dashboard.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const emails = [];
const texts = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('resend.com')) {
    try { emails.push(JSON.parse(init.body)); } catch { emails.push({}); }
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
const req = ({ method = 'GET', query = {}, body = null, uid = null }) => ({
  method, url: '/test', query, body,
  headers: {
    host: 'localhost:3001', origin: 'http://localhost:3001', 'content-type': 'application/json',
    'x-forwarded-for': `203.0.113.${(ipN++ % 200) + 10}`,
    ...(uid ? { cookie: `ivy_session=${signSession(uid)}` } : {}),
  },
  on() {},
});
const run = async (h, r) => { const res = mkRes(); await h(r, res); return res; };
const one = async (q) => (await q).rows[0];

const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const FULL_WEEK = JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 540, end: 1020 }]])));
async function mkBiz(tag) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`rebook-${tag}-${S}@example.com`}, 'x', 'Kim Owner', NOW()) RETURNING id`).rows[0].id;
  const w = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, 'Studio', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  const slug = `rebook-${tag}-${S}`;
  await sql.query(`INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, availability, min_notice_hours, slot_minutes, max_advance_days)
    VALUES ($1, $2, $3, 'UTC', $4::jsonb, 0, 30, 180)
    ON CONFLICT (workspace_id) DO UPDATE SET slug = EXCLUDED.slug, availability = EXCLUDED.availability, min_notice_hours = 0, max_advance_days = 180`,
  [w, `Studio ${tag}`, slug, FULL_WEEK]);
  const svc = (await sql`INSERT INTO services (workspace_id, name, price, duration_minutes) VALUES (${w}, 'Haircut', 60, 60) RETURNING id`).rows[0].id;
  return { userId: u, workspaceId: w, slug, svc, ctx: { workspaceId: w, userId: u } };
}
async function mkClient(biz, name, email, extra = {}) {
  return (await sql`INSERT INTO clients (workspace_id, name, email, phone, sms_consent_at, stage, user_id, notification_prefs)
    VALUES (${biz.workspaceId}, ${name}, ${email}, ${extra.phone || null}, ${extra.consent ? new Date().toISOString() : null}, 'active',
            ${extra.userId || null}, ${JSON.stringify(extra.prefs || {})}::jsonb) RETURNING id`).rows[0].id;
}
async function mkPast(biz, clientId, dateISO, start = 600, extra = {}) {
  return (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, source)
    VALUES (${biz.workspaceId}, ${extra.svc || biz.svc}, ${clientId}, 'Client', ${extra.email || null}, ${dateISO}, ${start}, ${start + 60}, 'owner') RETURNING id`).rows[0].id;
}
const todayISO = new Date().toISOString().slice(0, 10);

async function main() {
  await ensureSchemaApplied();

  // ── [1] the math ───────────────────────────────────────────────────────
  console.log('\n[1] suggestion math');
  assert(median([21, 14, 35]) === 21 && median([14, 28]) === 21 && median([]) === null, 'median: odd, even, empty');
  assert(JSON.stringify(gapsOf(['2026-01-02', '2026-01-23', '2026-01-23', '2026-02-13'])) === '[21,21]', 'gaps skip duplicate days');
  assert(weeksFromGapDays(21) === 3 && weeksFromGapDays(3) === 1 && weeksFromGapDays(200) === 12 && weeksFromGapDays(10) === 1 && weeksFromGapDays(11) === 2, 'weeks: rounded, clamped 1 to 12');
  const own = cadenceFrom({ clientDates: ['2026-01-02', '2026-01-23', '2026-02-13'], serviceGapsDays: [7] });
  assert(own.weeks === 3 && own.usual === true, "two gaps → the client's own rhythm (3 weeks), usual");
  const svcTypical = cadenceFrom({ clientDates: ['2026-01-02'], serviceGapsDays: [14, 14, 21] });
  assert(svcTypical.weeks === 2 && svcTypical.usual === false && svcTypical.basis === 'service', 'one visit → the service\'s typical gap, never "usual"');
  const dflt = cadenceFrom({ clientDates: [], serviceGapsDays: [] });
  assert(dflt.weeks === 4 && dflt.usual === false, 'no history → 4 weeks, never "usual"');
  const anchor = '2026-01-02'; // a Friday
  const d1 = suggestedDate({ anchorISO: anchor, weeks: 3, todayISO: '2026-01-10', maxAdvanceDays: 0 });
  assert(d1 === '2026-01-23' && weekdayOf(d1) === 5, 'anchor + 3 weeks, same weekday');
  const d2 = suggestedDate({ anchorISO: anchor, weeks: 3, todayISO: '2026-03-01', maxAdvanceDays: 0 });
  assert(d2 > '2026-03-01' && weekdayOf(d2) === 5 && d2 === '2026-03-06', 'a day already past rolls forward a week at a time, keeping the weekday');
  const d3 = suggestedDate({ anchorISO: anchor, weeks: 12, todayISO: '2026-01-03', maxAdvanceDays: 30 });
  assert(d3 <= addDaysISO('2026-01-03', 30) && weekdayOf(d3) === 5 && d3 > '2026-01-03', 'pulled back inside the booking horizon, same weekday');
  const starts = candidateStarts({ windows: [{ start: 540, end: 1020 }], duration: 60, step: 30, preferredStart: 600 });
  assert(starts[0] === 600 && starts[1] === 570 && starts[2] === 630 && !starts.includes(990), 'candidates nearest the usual time first, only ones that fit');

  const A = await mkBiz('a');
  const B = await mkBiz('b');
  const mayaUser = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`rebook-maya-${S}@example.com`}, 'x', 'Maya Rivera', NOW()) RETURNING id`).rows[0].id;
  const maya = await mkClient(A, 'Maya Rivera', `rebook-maya-${S}@example.com`, { phone: '+15551230001', consent: true, userId: mayaUser });
  // Three Friday visits, three weeks apart, 10:00.
  let friday = todayISO;
  while (weekdayOf(friday) !== 5) friday = addDaysISO(friday, -1);
  const last = addDaysISO(friday, -7);        // last Friday
  await mkPast(A, maya, addDaysISO(last, -42));
  await mkPast(A, maya, addDaysISO(last, -21));
  await mkPast(A, maya, last);
  const sug = await computeRebookSuggestion({ workspaceId: A.workspaceId, clientId: maya, serviceId: A.svc });
  assert(sug && sug.weeks === 3 && sug.usual === true, 'Maya: every 3 weeks, from her own visits');
  assert(sug.date === addDaysISO(last, 21) && sug.weekdayName === 'Friday', `suggested day is three Fridays after her last visit (${sug.date})`);
  assert(sug.startMin === 600 && sug.endMin === 660 && sug.slot === 'same', 'her usual 10:00 is free, so it is preselected');
  assert(usualLine(sug) === 'Your usual: every 3 weeks on Fridays', 'the "Your usual" line');
  // A block over 10:00 → nearest free time.
  const blk = await sql`INSERT INTO calendar_blocks (workspace_id, date, start_min, end_min, label) VALUES (${A.workspaceId}, ${sug.date}, 600, 660, 'x') RETURNING id`;
  const sug2 = await computeRebookSuggestion({ workspaceId: A.workspaceId, clientId: maya, serviceId: A.svc });
  assert(sug2.date === sug.date && sug2.slot === 'nearest' && (sug2.startMin === 540 || sug2.startMin === 660), `10:00 taken → the nearest free time (${sug2.startMin})`);
  await sql`DELETE FROM calendar_blocks WHERE id = ${blk.rows[0].id}`;
  const dayBlk = await sql`INSERT INTO calendar_blocks (workspace_id, date, start_min, end_min, label) VALUES (${A.workspaceId}, ${sug.date}, 0, 1440, 'x') RETURNING id`;
  const sug3 = await computeRebookSuggestion({ workspaceId: A.workspaceId, clientId: maya, serviceId: A.svc });
  assert(sug3.date === sug.date && sug3.slot === 'none' && sug3.startMin === null, 'whole day taken → the day alone, no time');
  await sql`DELETE FROM calendar_blocks WHERE id = ${dayBlk.rows[0].id}`;
  // One visit → the service's typical gap from other clients (2 weeks); never "usual".
  const sam = await mkClient(A, 'Sam One', `rebook-sam-${S}@example.com`);
  const zoe = await mkClient(A, 'Zoe Regular', `rebook-zoe-${S}@example.com`);
  await mkPast(A, zoe, addDaysISO(last, -28)); await mkPast(A, zoe, addDaysISO(last, -14)); await mkPast(A, zoe, last);
  await mkPast(A, sam, addDaysISO(friday, -6)); // a Saturday
  const sugSam = await computeRebookSuggestion({ workspaceId: A.workspaceId, clientId: sam, serviceId: A.svc });
  assert(sugSam.usual === false && usualLine(sugSam) === null && sugSam.weekdayName === 'Saturday', 'one visit: no "Your usual" line, same weekday as that visit');
  assert(sugSam.weeks === 2 || sugSam.weeks === 3, `cadence from the service's other clients (${sugSam.weeks} weeks)`);
  const newbie = await mkClient(B, 'New B', `rebook-newb-${S}@example.com`);
  const sugNew = await computeRebookSuggestion({ workspaceId: B.workspaceId, clientId: newbie, serviceId: B.svc });
  assert(sugNew.weeks === 4 && sugNew.usual === false, 'no history at all: 4 weeks, not "usual"');
  assert((await computeRebookSuggestion({ workspaceId: B.workspaceId, clientId: maya, serviceId: A.svc })) === null, "another business's service is not found");

  // ── [2] tokens ─────────────────────────────────────────────────────────
  console.log('\n[2] tokens');
  const token = mintRebookToken({ workspaceId: A.workspaceId, clientId: maya, serviceId: A.svc });
  const v = verifyRebookToken(token);
  assert(v && v.workspaceId === A.workspaceId && v.clientId === maya && v.serviceId === A.svc, 'a minted token verifies');
  assert(verifyRebookToken(token.slice(0, -2) + 'xx') === null, 'a tampered signature is refused');
  const [body] = token.split('.');
  assert(verifyRebookToken(`${body}x.${token.split('.')[1]}`) === null, 'a tampered payload is refused');
  const old = mintRebookToken({ workspaceId: A.workspaceId, clientId: maya, serviceId: A.svc, now: Date.now() - 91 * 86400000 });
  assert(verifyRebookToken(old) === null, 'a 91-day-old token has expired');
  assert(verifyRebookToken('') === null && verifyRebookToken('abc') === null && verifyRebookToken(null) === null, 'junk is refused');
  const okRes = await run(publicRebook, req({ query: { token, slug: A.slug } }));
  assert(okRes.statusCode === 200 && okRes.body.rebook.serviceId === A.svc && okRes.body.rebook.date === sug.date && okRes.body.rebook.startMin === 600, 'the public endpoint answers the service, day and time');
  assert(okRes.body.rebook.usualLine === 'Your usual: every 3 weeks on Fridays' && /We picked Friday/.test(okRes.body.rebook.pickedLine), 'with the usual line and the picked line');
  const leak = JSON.stringify(okRes.body).toLowerCase();
  assert(!leak.includes('maya') && !leak.includes('@example.com') && !leak.includes(A.workspaceId) && !leak.includes(maya), 'and nothing about the client or the business ids');
  assert((await run(publicRebook, req({ query: { token, slug: B.slug } }))).statusCode === 404, "the same token on another business's page is a 404");
  assert((await run(publicRebook, req({ query: { token: old, slug: A.slug } }))).statusCode === 404, 'an expired token is a 404');
  assert((await run(publicRebook, req({ query: { token: 'forged.forged', slug: A.slug } }))).statusCode === 404, 'a forged token is a 404');

  // ── [3] opt-outs and consent ──────────────────────────────────────────
  console.log('\n[3] opt-outs');
  emails.length = 0; texts.length = 0;
  const out1 = await sendRebookLink({ workspaceId: A.workspaceId, clientId: maya, serviceId: A.svc });
  assert(out1.ok && out1.emailed && out1.texted, 'Maya (email + SMS consent): emailed and texted');
  assert(mailsTo(`rebook-maya-${S}@example.com`).length === 1 && /Ready for your next Haircut/.test(emails[0].subject), 'the email: "Ready for your next Haircut?"');
  assert(/Your usual: every 3 weeks on Fridays/.test(emails[0].html) && emails[0].html.includes(`/book/${A.slug}?rebook=`), 'with her usual rhythm and the signed link');
  assert(texts.length === 1 && /Book again here: https:\/\/www\.joinivy\.ai\/book\//.test(texts[0].Body), 'the text carries the link');
  const muted = await mkClient(A, 'Mia Muted', `rebook-muted-${S}@example.com`, { prefs: { marketing: false }, phone: '+15551230002' });
  await mkPast(A, muted, last);
  emails.length = 0; texts.length = 0;
  const out2 = await sendRebookLink({ workspaceId: A.workspaceId, clientId: muted, serviceId: A.svc });
  assert(!out2.ok && !out2.emailed && /turned off/.test(out2.emailReason) && emails.length === 0, 'a client who turned off these emails gets none');
  assert(!out2.texted && /not agreed/.test(out2.smsReason) && texts.length === 0, 'no SMS consent → no text');
  const outB = await sendRebookLink({ workspaceId: B.workspaceId, clientId: maya, serviceId: A.svc });
  assert(outB.error === 'Client not found', "another business cannot send to A's client");

  // ── [4] the owner's button ─────────────────────────────────────────────
  console.log('\n[4] owner "Send rebook link"');
  const bk = await one(sql`SELECT id FROM bookings WHERE client_id = ${maya} ORDER BY date DESC LIMIT 1`);
  await sql`DELETE FROM rate_limits WHERE key LIKE ${'rebook:%'}`;
  emails.length = 0;
  const r1 = await run(rebookLinkApi, req({ method: 'POST', body: { id: bk.id }, uid: A.userId }));
  assert(r1.statusCode === 200 && r1.body.sent && r1.body.emailed && r1.body.url.includes('?rebook='), 'owner sends: 200, emailed, link returned');
  assert((await one(sql`SELECT rebook_link_sent_at FROM bookings WHERE id = ${bk.id}`)).rebook_link_sent_at, 'the booking records when the link was sent');
  const r2 = await run(rebookLinkApi, req({ method: 'POST', body: { id: bk.id }, uid: A.userId }));
  const r3 = await run(rebookLinkApi, req({ method: 'POST', body: { id: bk.id }, uid: A.userId }));
  assert(r2.statusCode === 200 && r3.statusCode === 429 && /already got a rebook link today/.test(r3.body.error), 'rate limited: two a day per client, the third is refused');
  assert((await run(rebookLinkApi, req({ method: 'POST', body: { id: bk.id }, uid: B.userId }))).statusCode === 404, "another owner cannot send for A's booking");
  assert((await run(rebookLinkApi, req({ method: 'POST', body: { id: 'nope' }, uid: A.userId }))).statusCode === 400, 'a bad id is refused');
  assert((await run(rebookLinkApi, req({ method: 'POST', body: { id: bk.id } }))).statusCode === 401, 'signed out is refused');

  // ── [5] booking through the link ───────────────────────────────────────
  console.log('\n[5] booked_via = rebook');
  const bookBody = (extra) => ({ serviceId: A.svc, date: sug.date, startMin: 600, endMin: 660, clientName: 'Maya Rivera', clientEmail: `rebook-maya-${S}@example.com`, ...extra });
  const b1 = await run(slugHandler, req({ method: 'POST', query: { slug: A.slug }, body: bookBody({ rebook: token }) }));
  assert(b1.statusCode === 201, `booking through the link goes through (${b1.statusCode} ${b1.body?.error || ''})`);
  const row1 = b1.body?.booking?.id ? await one(sql`SELECT booked_via, source, client_id FROM bookings WHERE id = ${b1.body.booking.id}`) : null;
  assert(row1 && row1.booked_via === 'rebook' && row1.source === 'client' && row1.client_id === maya, "marked booked_via = 'rebook', source still 'client', attached to Maya");
  const tokenB = mintRebookToken({ workspaceId: B.workspaceId, clientId: newbie, serviceId: B.svc });
  const b2 = await run(slugHandler, req({ method: 'POST', query: { slug: A.slug }, body: bookBody({ rebook: tokenB, startMin: 720, endMin: 780 }) }));
  const row2 = b2.body?.booking?.id ? await one(sql`SELECT booked_via FROM bookings WHERE id = ${b2.body.booking.id}`) : null;
  assert(b2.statusCode === 201 && row2 && row2.booked_via === null, "a token for another business books normally, not marked");
  const b3 = await run(slugHandler, req({ method: 'POST', query: { slug: A.slug }, body: bookBody({ rebook: 'junk.junk', startMin: 780, endMin: 840 }) }));
  const row3 = b3.body?.booking?.id ? await one(sql`SELECT booked_via FROM bookings WHERE id = ${b3.body.booking.id}`) : null;
  assert(b3.statusCode === 201 && row3 && row3.booked_via === null, 'junk is ignored, the booking still goes through');
  const kA = await keyNumbers(A.workspaceId, 'UTC');
  const kB = await keyNumbers(B.workspaceId, 'UTC');
  assert(kA.rebookedViaLink === 1 && kB.rebookedViaLink === 0, 'dashboard: A has 1 rebooked via link this month, B has 0');
  const dash = await run(dashboard, req({ uid: A.userId }));
  assert(dash.statusCode === 200 && dash.body.keyNumbers?.rebookedViaLink === 1 && dash.body.keyNumbers.rebooking, '/api/dashboard keyNumbers.rebookedViaLink (additive, old fields intact)');

  // ── [6] the client portal ──────────────────────────────────────────────
  console.log('\n[6] client portal');
  const me = await run(meBookings, req({ uid: mayaUser }));
  const pastA = (me.body?.past || []).find((b) => b.bizSlug === A.slug);
  assert(me.statusCode === 200 && pastA && pastA.rebook && pastA.rebook.path.startsWith(`/book/${A.slug}?rebook=`), 'the last past visit carries the rebook path');
  assert(pastA.rebook.usual === true && pastA.rebook.usualLine === 'Your usual: every 3 weeks on Fridays' && pastA.rebook.weekdayName === 'Friday', '...with her own rhythm');
  const vt = verifyRebookToken(decodeURIComponent(pastA.rebook.path.split('rebook=')[1]));
  assert(vt && vt.clientId === maya && vt.workspaceId === A.workspaceId, 'the path\'s token is hers, for this business');

  // ── [7] Ivy ────────────────────────────────────────────────────────────
  console.log('\n[7] Ivy send_rebook_link');
  await sql`DELETE FROM rate_limits WHERE key LIKE ${'rebook:%'}`;
  emails.length = 0;
  const n0 = (await one(sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId}`)).n;
  const held = await executeIvyTool('send_rebook_link', { client_id: maya }, A.ctx);
  assert(held.needs_confirmation === true && /Maya Rivera a link to book Haircut again/.test(held.summary) && /their usual: every 3 weeks on Fridays/.test(held.summary), `held with a card: ${held.summary}`);
  assert(emails.length === 0 && (await one(sql`SELECT COUNT(*)::int AS n FROM ivy_pending_actions WHERE workspace_id = ${A.workspaceId}`)).n === n0 + 1, 'nothing sent before approval');
  assert(ledgerEntry('send_rebook_link', { client_id: maya }, held)?.status === 'waiting', 'ledger: waiting');
  const row = await one(sql`SELECT id, session_id, tool, args, summary FROM ivy_pending_actions WHERE id = ${held.pending_id}`);
  const done = await executePendingAction({ row, workspaceId: A.workspaceId, userId: A.userId });
  assert(done.claimed && !done.result.error && done.result.emailed && mailsTo(`rebook-maya-${S}@example.com`).length === 1, 'approved: the email went out once');
  assert(/^Done\. Emailed and texted Maya Rivera a rebook link for Haircut, opening on Friday/.test(done.text), `done line: ${done.text}`);
  const again = await executePendingAction({ row, workspaceId: A.workspaceId, userId: A.userId });
  assert(again.claimed === false && mailsTo(`rebook-maya-${S}@example.com`).length === 1, 'a second tap on the same card sends nothing more');
  const refused = await executeIvyTool('send_rebook_link', { client_id: maya }, B.ctx);
  assert(/Client not found/.test(refused.error || ''), "another business's Ivy is refused before any card");
  const noHist = await executeIvyTool('send_rebook_link', { client_id: newbie }, B.ctx);
  assert(/no past appointment/.test(noHist.error || ''), 'a client with no past appointment is refused before any card');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
