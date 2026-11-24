// The exit interview: asking an owner why they cancelled.
//   [1] who is asked, and that each cancellation is asked once
//   [2] the answer, from inside the app
//   [3] the link in the email (no sign-in)
//   [4] the delete-account question; nothing identifying is kept
//   [5] what the operator sees, and who may see it
//   [6] the emails and the screens
//
// Run: node --import ./tests/bootstrap.mjs ./tests/exit-interview.test.mjs
import { readFileSync } from 'node:fs';
process.env.SUPER_ADMIN_EMAIL = `exit-admin-${Date.now()}@example.com`;

const { ensureSchemaApplied } = await import('../api/_lib/ensureSchema.js');
const { sql } = await import('../api/_lib/db.js');
const { signSession } = await import('../api/_lib/auth.js');
const lib = await import('../api/_lib/exitInterview.js');
const { default: meHandler } = await import('../api/me/index.js');
const { default: answerHandler } = await import('../api/me/exit-interview.js');
const { default: linkHandler } = await import('../api/exit-interview.js');
const { default: adminHandler } = await import('../api/admin/exit-answers.js');
const { renderSubscriptionCancelled, renderPlanEnding } = await import('../api/_lib/subscriptionNotify.js');

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const users = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const inDays = (d) => new Date(Date.now() + d * 86400e3).toISOString();
function mkRes() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end(s) { if (s !== undefined) this.body = s; return this; } };
}
async function call(handler, userId, { method = 'POST', body, query = {}, origin = 'http://localhost:3000' } = {}) {
  const req = { method, url: '/api/x', query, body, headers: { ...(userId ? { cookie: `ivy_session=${signSession(userId)}` } : {}), ...(origin ? { origin } : {}), host: 'localhost:3000', 'content-type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } };
  const res = mkRes(); res.req = req;
  await handler(req, res);
  return res;
}
const mk = async (tag, { status = 'active', cancelAtEnd = false, periodEnd = inDays(20), email, createdDaysAgo = 200 } = {}) => {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role)
    VALUES (${email || `exit-${tag}-${S}@example.com`}, 'x', 'Exit Owner', NOW(), 'owner') RETURNING id`).rows[0];
  users.push(u.id);
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, cancel_at_period_end, onboarded_at, created_at, business_type, subscription_source)
    VALUES (${u.id}, ${status}, ${periodEnd}, ${cancelAtEnd}, NOW(), ${inDays(-createdDaysAgo)}, 'service', 'stripe') RETURNING id`).rows[0].id;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name) VALUES (${ws}, ${`Studio ${tag}`}) ON CONFLICT (workspace_id) DO UPDATE SET biz_name = EXCLUDED.biz_name`.catch(() => {});
  return { userId: u.id, ws };
};
const rowsFor = async (ws) => (await sql`SELECT * FROM exit_answers WHERE workspace_id = ${ws} ORDER BY created_at`).rows;

async function main() {
  await ensureSchemaApplied();

  console.log('\n[1] who is asked');
  const happy = await mk('happy');
  const leaving = await mk('leaving', { cancelAtEnd: true });
  const ended = await mk('ended', { status: 'cancelled', periodEnd: inDays(-3) });
  const trialOver = await mk('trial', { status: 'trialing', periodEnd: null });
  const trialCancelled = await mk('trialc', { status: 'trialing', cancelAtEnd: true, periodEnd: inDays(5) });
  assert((await lib.exitInterviewState(happy.ws)).due === false, 'an owner with a running plan is not asked');
  assert((await lib.exitInterviewState(leaving.ws)).due === true, 'an owner who turned renewal off is asked');
  assert((await lib.exitInterviewState(ended.ws)).due === true, 'an owner whose paid plan ended is asked');
  assert((await lib.exitInterviewState(trialCancelled.ws)).due === true, 'so is one who started a trial with a card and cancelled it');
  assert((await lib.exitInterviewState(trialOver.ws)).due === false, 'a free trial that simply ran out is not a cancellation');
  assert((await lib.exitInterviewState(null)).due === false && (await lib.exitInterviewState('00000000-0000-4000-8000-000000000000')).due === false, 'no business: nobody to ask');
  let r = await call(meHandler, leaving.userId, { method: 'GET' });
  assert(r.statusCode === 200 && r.body.exitInterview?.due === true, 'the app is told to ask');
  r = await call(meHandler, happy.userId, { method: 'GET' });
  assert(r.body.exitInterview?.due === false, 'and told not to for everyone else');

  console.log('\n[2] answering in the app');
  r = await call(answerHandler, leaving.userId, { body: {} });
  assert(r.statusCode === 400, 'an empty answer is refused');
  r = await call(answerHandler, leaving.userId, { body: { skipped: true } });
  assert(r.statusCode === 200 && (await lib.exitInterviewState(leaving.ws)).due === false, '"Not now" is remembered: the app does not ask again');
  let rows = await rowsFor(leaving.ws);
  assert(rows.length === 1 && rows[0].skipped === true && rows[0].reasons.length === 0, 'it is stored as "not now", with no reasons');
  r = await call(answerHandler, leaving.userId, { body: { reasons: ['too_expensive', 'missing_feature', 'made_up', 'too_expensive'], comment: `  I needed recurring\u0000 blocks ${S}.  ` } });
  rows = await rowsFor(leaving.ws);
  assert(r.statusCode === 200 && r.body.saved === true && rows.length === 1 && rows[0].skipped === false, 'a real answer later replaces the "not now" (still one row for this cancellation)');
  assert(JSON.stringify(rows[0].reasons) === '["too_expensive","missing_feature"]', 'only reasons from the list are kept, each once');
  assert(rows[0].comment === `I needed recurring blocks ${S}.`, 'the comment is trimmed and cleaned');
  assert(rows[0].months_with_ivy === 6 && rows[0].business_type === 'service' && rows[0].plan_source === 'stripe' && rows[0].channel === 'app' && rows[0].source === 'cancel', 'with context that is not about a person: months with Ivy, kind of business, how they paid');
  r = await call(answerHandler, leaving.userId, { body: { reasons: ['other'], comment: 'second go' } });
  rows = await rowsFor(leaving.ws);
  assert(r.body.saved === false && r.body.already === true && rows.length === 1 && rows[0].comment === `I needed recurring blocks ${S}.`, 'a second answer to the same cancellation does not overwrite the first');
  r = await call(answerHandler, leaving.userId, { body: { comment: 'x'.repeat(5000) } });
  assert(r.statusCode === 200 && rows[0].comment.length < 1001, 'nothing longer than the limit can be stored');
  r = await call(answerHandler, happy.userId, { body: { reasons: ['other'] } });
  assert(r.statusCode === 400 && (await rowsFor(happy.ws)).length === 0, 'an owner who has not cancelled cannot file one');
  r = await call(answerHandler, null, { body: { reasons: ['other'] } });
  assert(r.statusCode === 401, 'signed out: refused');
  r = await call(answerHandler, leaving.userId, { method: 'GET' });
  assert(r.statusCode === 405, 'it only takes answers');
  // comes back, cancels again later: asked again
  await sql`UPDATE workspaces SET cancel_at_period_end = FALSE WHERE id = ${leaving.ws}`;
  assert((await lib.exitInterviewState(leaving.ws)).due === false, 'turning renewal back on ends the question');
  await sql`UPDATE workspaces SET cancel_at_period_end = TRUE, subscription_period_end = ${inDays(60)} WHERE id = ${leaving.ws}`;
  assert((await lib.exitInterviewState(leaving.ws)).due === true, 'cancelling again later is a new cancellation, asked once more');

  console.log('\n[3] the link in the email');
  const token = lib.makeExitToken(ended.ws);
  assert(lib.readExitToken(token) === ended.ws, 'the link names one business');
  const [w, exp, sig] = token.split('.');
  for (const [what, bad] of [
    ['another business', `${happy.ws}.${exp}.${sig}`], ['a later expiry', `${w}.${Number(exp) + 9e9}.${sig}`],
    ['a changed signature', `${w}.${exp}.${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`], ['no signature', `${w}.${exp}.`], ['junk', 'hello'], ['nothing', ''],
  ]) assert(lib.readExitToken(bad) === null, `a link with ${what} is refused`);
  assert(lib.readExitToken(lib.makeExitToken(ended.ws, Date.now() - (lib.TOKEN_TTL_DAYS + 1) * 86400e3)) === null, 'an expired link is refused');
  r = await call(linkHandler, null, { method: 'GET', query: { token } });
  assert(r.statusCode === 200 && r.body.open === true && r.body.answered === false && r.body.business === 'Studio ended' && r.body.reasons.length === lib.EXIT_REASONS.length, 'opening it shows the question for that business, with no sign-in');
  assert(!/@|[0-9a-f]{8}-[0-9a-f]{4}-/.test(JSON.stringify(r.body)), 'and gives away nothing else: no email, no ids');
  r = await call(linkHandler, null, { method: 'GET', query: { token: 'nope' } });
  assert(r.statusCode === 404, 'a bad link gets a plain "not valid"');
  r = await call(linkHandler, null, { method: 'POST', query: { token }, body: { reasons: ['not_using'], comment: `Too busy to set it up ${S}` }, origin: 'https://evil.example' });
  assert(r.statusCode !== 200 && (await rowsFor(ended.ws)).length === 0, 'an answer posted from another website is refused');
  r = await call(linkHandler, null, { method: 'POST', query: { token }, body: { reasons: ['not_using'], comment: `Too busy to set it up ${S}`, skipped: true } });
  rows = await rowsFor(ended.ws);
  assert(r.statusCode === 200 && rows.length === 1 && rows[0].channel === 'email' && rows[0].skipped === false && rows[0].reasons[0] === 'not_using', 'answering from the email is stored (and cannot be turned into a "skip")');
  assert((await rowsFor(happy.ws)).length === 0 && (await rowsFor(trialCancelled.ws)).length === 0, 'only for the business the link is for');
  r = await call(linkHandler, null, { method: 'GET', query: { token } });
  assert(r.body.answered === true, 'opening the link again says thank you instead of asking twice');
  assert((await lib.exitInterviewState(ended.ws)).due === false, 'and the app no longer asks either');
  // "Not now" in the app is not an answer: the email link still asks.
  const later = await mk('later', { cancelAtEnd: true });
  await call(answerHandler, later.userId, { body: { skipped: true } });
  r = await call(linkHandler, null, { method: 'GET', query: { token: lib.makeExitToken(later.ws) } });
  assert(r.body.open === true && r.body.answered === false, 'an owner who tapped "Not now" in the app can still answer from the email');
  r = await call(linkHandler, null, { method: 'POST', query: { token: lib.makeExitToken(later.ws) }, body: { reasons: ['taking_a_break'] } });
  rows = await rowsFor(later.ws);
  assert(r.body.saved === true && rows.length === 1 && rows[0].skipped === false && rows[0].channel === 'email', 'and that answer replaces the "not now"');
  r = await call(linkHandler, null, { method: 'POST', query: { token: lib.makeExitToken(happy.ws) }, body: { reasons: ['other'] } });
  assert(r.statusCode === 400 && (await rowsFor(happy.ws)).length === 0, 'a link for a business whose plan is running records nothing');

  console.log('\n[3b] a free trial that ran out');
  const mkTrial = async (tag, { endedDaysAgo = 2, comp = false } = {}) => {
    const o = await mk(tag, { status: 'trialing', periodEnd: null, createdDaysAgo: 16 });
    await sql`UPDATE workspaces SET trial_ends_at = ${inDays(-endedDaysAgo)}, comp_until = ${comp ? inDays(30) : null} WHERE id = ${o.ws}`;
    return o;
  };
  const lapsed = await mkTrial('lapsed');
  const stillTrying = await mkTrial('trying', { endedDaysAgo: -5 });
  const comped = await mkTrial('comped', { comp: true });
  let st = await lib.exitInterviewState(lapsed.ws);
  assert(st.kind === 'trial' && st.due === true && st.answered === false, 'an owner whose free trial ended with no plan is asked what stopped them');
  assert((await lib.exitInterviewState(stillTrying.ws)).kind === null, 'one whose trial is still running is not');
  assert((await lib.exitInterviewState(comped.ws)).kind === null, 'nor one with complimentary access');
  assert((await lib.exitInterviewState(leaving.ws)).kind === 'cancel', 'a cancellation is still a cancellation');
  r = await call(meHandler, lapsed.userId, { method: 'GET' });
  assert(r.body.exitInterview?.kind === 'trial' && r.body.exitInterview.answered === false, 'the app is told, so the paywall can offer the link');
  assert(lib.reasonsFor('trial').some((x) => x.id === 'not_enough_time') && lib.reasonsFor('trial').some((x) => x.id === 'still_deciding') && !lib.reasonsFor('trial').some((x) => x.id === 'not_using' || x.id === 'taking_a_break'), 'the reasons fit a trial: "no time to try it" and "still deciding" instead of "was not using it"');
  r = await call(linkHandler, null, { method: 'GET', query: { token: lib.makeExitToken(lapsed.ws) } });
  assert(r.statusCode === 200 && r.body.kind === 'trial' && r.body.open === true && r.body.reasons.length === lib.TRIAL_REASONS.length && r.body.reasons.some((x) => x.id === 'still_deciding'), 'the email link asks the trial question, with the trial reasons');
  r = await call(answerHandler, lapsed.userId, { body: { source: 'cancel', reasons: ['not_enough_time', 'too_expensive'], comment: `Busy season ${S}` } });
  rows = await rowsFor(lapsed.ws);
  assert(r.statusCode === 200 && r.body.kind === 'trial' && rows.length === 1 && rows[0].source === 'trial' && rows[0].plan_source === 'trial' && rows[0].cancel_ref.startsWith('trial:'), 'the answer is filed as a trial that ran out, whatever the app claims (the server decides which it is)');
  assert(JSON.stringify(rows[0].reasons) === '["not_enough_time","too_expensive"]', 'with the reasons picked');
  st = await lib.exitInterviewState(lapsed.ws);
  assert(st.answered === true && st.due === false, 'then the link is no longer offered');
  r = await call(answerHandler, lapsed.userId, { body: { reasons: ['other'] } });
  assert(r.body.saved === false && (await rowsFor(lapsed.ws)).length === 1, 'and a second answer does not replace the first');
  r = await call(answerHandler, stillTrying.userId, { body: { reasons: ['other'] } });
  assert(r.statusCode === 400 && (await rowsFor(stillTrying.ws)).length === 0, 'an owner still inside their trial cannot file one');
  // subscribing later, then cancelling, is a new question of the other kind
  await sql`UPDATE workspaces SET subscription_status = 'active', subscription_period_end = ${inDays(25)}, cancel_at_period_end = TRUE WHERE id = ${lapsed.ws}`;
  st = await lib.exitInterviewState(lapsed.ws);
  assert(st.kind === 'cancel' && st.due === true, 'if they subscribe after all and cancel later, that is asked as a cancellation, separately');
  const paywall = read('src/features/billing/Paywall.jsx');
  assert(/const askWhy = trialExpired && ctx\?\.exitInterview\?\.kind === 'trial' && !ctx\?\.exitInterview\?\.answered && !whyDone;/.test(paywall) && /Not subscribing\? Tell us why/.test(paywall), 'the paywall offers one quiet link, only to an owner whose trial ran out and who has not answered');
  assert(/\{whyOpen && \(\s*<ExitInterviewSheet due kind="trial" manual/.test(paywall) && !/useEffect\([^)]*setWhyOpen\(true\)/.test(paywall), 'it opens only when tapped: nothing pops up over the subscribe screen');
  assert(/if \(skipped && manual\) \{ close\(\); return; \}/.test(read('src/components/ExitInterviewSheet.jsx')), 'closing it records nothing');
  const { renderTrialReminder } = await import('../api/_lib/subscriptionNotify.js');
  const tUrl = lib.exitLink(lapsed.ws, 'https://www.joinivy.ai');
  let tm = renderTrialReminder({ stage: 'expired', trialEndsAt: new Date(), firstName: 'Kay', businessName: 'Studio', exitUrl: tUrl });
  assert(tm.html.includes(tUrl) && /Tell us what stopped you/.test(tm.html), 'the "your trial has ended" email asks, with the link');
  tm = renderTrialReminder({ stage: 'expired', trialEndsAt: new Date(), firstName: 'Kay', businessName: 'Studio' });
  assert(!/\/exit\//.test(tm.html), 'with no link it simply does not ask');
  for (const stage of ['7d', '2d', '1d']) {
    tm = renderTrialReminder({ stage, trialEndsAt: new Date(Date.now() + 86400e3), firstName: 'Kay', businessName: 'Studio', exitUrl: tUrl });
    if (/\/exit\//.test(tm.html)) assert(false, `the ${stage} reminder (trial still running) does not ask why they are leaving`);
  }
  assert(/exitUrl: stage === 'expired' \? exitLink\(workspaceId, appUrl\(\)\) : null/.test(read('api/_lib/subscriptionNotify.js')), 'only the ended-trial email carries it');
  const sumT = await lib.exitSummary({ days: 90, source: 'trial' });
  assert(sumT.source === 'trial' && sumT.answers.some((x) => String(x.comment || '').includes(S)) && sumT.answers.every((x) => x.source === 'trial') && sumT.reasons.some((x) => x.id === 'still_deciding') && !sumT.reasons.some((x) => x.id === 'taking_a_break'), 'the operator can look at trial answers alone, with the trial reasons');
  const sumC = await lib.exitSummary({ days: 90, source: 'cancel' });
  assert(sumC.answers.every((x) => x.source === 'cancel') && typeof sumC.bySource.trial === 'number' && sumC.bySource.trial >= 1, 'or cancellations alone, with a count for each group');
  assert((await lib.exitSummary({ days: 90, source: 'nonsense' })).source === 'all', 'an unknown group shows everyone');

  console.log('\n[4] deleting an account');
  const going = await mk('going');
  r = await call(answerHandler, going.userId, { body: { source: 'delete', reasons: ['business_closed'], comment: `Retiring ${S}` } });
  assert(r.statusCode === 200 && (await rowsFor(going.ws))[0]?.source === 'delete', 'the delete screen can file a reason even though nothing was cancelled');
  const answerId = (await rowsFor(going.ws))[0].id;
  await sql`DELETE FROM users WHERE id = ${going.userId}`;
  const kept = (await sql`SELECT * FROM exit_answers WHERE id = ${answerId}`).rows[0];
  assert(kept && kept.workspace_id === null && kept.comment === `Retiring ${S}`, 'when the account is deleted the answer stays, no longer attached to any business');
  const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'exit_answers'`).rows.map((c) => c.column_name);
  assert(!cols.some((c) => /(^|_)(email|name|user|phone|ip|address)(_|$)/.test(c)), `the table has no column for a name, an email, a phone or a network address (${cols.join(', ')})`);

  console.log('\n[5] what the operator sees');
  const sum = await lib.exitSummary({ days: 90 });
  const mine = sum.answers.filter((a) => String(a.comment || '').includes(S));
  assert(mine.length === 4, 'the four answers above are listed (three leavers and the trial)');
  assert(mine.find((a) => a.comment.startsWith('Retiring')).business === null && mine.find((a) => a.comment.startsWith('Too busy')).business === 'Studio ended', 'with the business name only while the account still exists');
  assert(mine.find((a) => a.comment.startsWith('I needed')).reasons.join('|') === 'It costs too much|It is missing something I need', 'reasons are shown in plain words');
  assert(sum.reasons.every((x) => x.pct >= 0 && x.pct <= 100) && sum.answered >= 3 && sum.asked >= sum.answered, 'with a count and share for each reason');
  assert((await lib.exitSummary({ days: 7777 })).days === 90, 'the period is 30, 90 or 365 days');
  r = await call(adminHandler, happy.userId, { method: 'GET' });
  assert(r.statusCode !== 200 && !r.body?.answers, 'a business account cannot read other people\'s answers');
  r = await call(adminHandler, null, { method: 'GET' });
  assert(r.statusCode !== 200, 'nor a signed-out visitor');
  const admin = await mk('admin', { email: process.env.SUPER_ADMIN_EMAIL });
  r = await call(adminHandler, admin.userId, { method: 'GET', query: { days: '90' } });
  assert(r.statusCode === 200 && Array.isArray(r.body.answers) && Array.isArray(r.body.reasons), 'the operator can');

  console.log('\n[6] the emails and the screens');
  const url = lib.exitLink(ended.ws, 'https://www.joinivy.ai/');
  assert(/^https:\/\/www\.joinivy\.ai\/exit\/[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/.test(url), 'the email link is a normal Ivy address');
  let mail = renderSubscriptionCancelled({ endsAt: null, firstName: 'Kay', businessName: 'Studio', exitUrl: url });
  assert(mail.html.includes(url) && /Tell us why you are leaving/.test(mail.html), 'the "cancelled" email asks, with the link');
  mail = renderPlanEnding({ endsAt: new Date(), firstName: 'Kay', businessName: 'Studio', source: 'stripe', exitUrl: url });
  assert(mail.html.includes(url), 'so does the "your plan is ending" email');
  mail = renderSubscriptionCancelled({ endsAt: null, firstName: 'Kay', businessName: 'Studio' });
  assert(!/\/exit\//.test(mail.html) && /just reply/.test(mail.html), 'with no link it falls back to "just reply"');
  mail = renderSubscriptionCancelled({ endsAt: null, firstName: 'Kay', businessName: 'Studio', exitUrl: 'javascript:alert(1)' });
  assert(!/javascript:/.test(mail.html), 'and never puts anything but a web address in the button');
  const shell = read('src/components/layout/AppShell.jsx');
  assert(/<ExitInterviewSheet kind="cancel"\s+due=\{!!ctx\?\.isOwner && !!ctx\?\.exitInterview\?\.due && ctx\?\.exitInterview\?\.kind === 'cancel' && !impersonating && !onHold && !showWalkthrough && !answersOpen\}/.test(shell), 'the app shows the question once, to the owner only, never to an operator viewing as them, and only for a cancellation');
  const sheet = read('src/components/ExitInterviewSheet.jsx');
  assert(/Not now/.test(sheet) && /if \(skipped\) close\(true\); else setErr/.test(sheet), '"Not now" always closes it, even if saving that failed');
  const form = read('src/components/ExitInterviewForm.jsx');
  const listIn = (src, from, to) => [...src.slice(src.indexOf(from), src.indexOf(to)).matchAll(/id: '(\w+)', label: '([^']+)'/g)].map((m) => `${m[1]}=${m[2]}`).join('|');
  const same = (list) => list.map((x) => `${x.id}=${x.label}`).join('|');
  assert(listIn(form, 'export const EXIT_REASONS', 'export const TRIAL_REASONS') === same(lib.EXIT_REASONS), 'the screen offers exactly the reasons the server accepts, in the same words');
  assert(listIn(form, 'export const TRIAL_REASONS', 'export const reasonsFor') === same(lib.TRIAL_REASONS), 'and the same for the trial question');
  assert(!/[–—]| - /.test(JSON.stringify(lib.EXIT_REASONS) + sheet.replace(/\/\/.*$/gm, '')), 'no dashes in the wording');
  const acct = read('src/features/account/AccountPage.jsx');
  assert(/data-delete-why/.test(acct) && /api\.post\('\/me\/exit-interview', \{ source: 'delete'/.test(acct) && /\.catch\(\(\) => \{\}\);\s*\}\s*const res = await fetch\('\/api\/account\/delete'/.test(acct), 'the delete screen asks (optional), and a failure to save the answer never blocks the delete');
  assert(/path="\/exit\/:token"\s+element=\{<ExitPage \/>\}/.test(read('src/App.jsx')) && (read('public/robots.txt').match(/Disallow: \/exit\//g) || []).length >= 2, 'the email link has its own page, kept out of search engines');
  assert(/tab === 'exits'\s+&& <ExitAnswersTab\/>/.test(read('src/features/admin/AdminPage.jsx')), 'Admin has an Exit answers tab');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  await sql`DELETE FROM exit_answers WHERE comment LIKE ${`%${S}%`} OR (workspace_id IS NULL AND comment IN ('Retiring', 'I needed recurring blocks.', 'Too busy to set it up'))`.catch(() => {});
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
