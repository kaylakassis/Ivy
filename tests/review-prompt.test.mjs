// "Loving Ivy?" weekly check-in: who gets asked, how often, and that the
// answer endpoint records choices and sets the next ask.
// Run: node --import ./tests/bootstrap.mjs ./tests/review-prompt.test.mjs
process.env.CRON_SECRET = 'cron-review-test';
process.env.REVIEW_PROMPT_ENABLED = 'true';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { dueForReviewPrompt, sendReviewPrompts, PUSH_PAYLOAD } from '../api/_lib/reviewPrompt.js';
import cron from '../api/cron/review-ask.js';
import answerHandler from '../api/me/review-prompt.js';
import { signSession } from '../api/_lib/auth.js';
import fs from 'node:fs';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const mkRes = () => { const r = { statusCode: 200, body: null, headers: {}, setHeader(k, v) { r.headers[k] = v; }, getHeader(k) { return r.headers[k]; }, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; };

async function owner(tag, { age = '30 days', active = '1 day', ios = true, onboarded = true, status = 'active', cols = {} } = {}) {
  const u = await sql.query(
    `INSERT INTO users (email, password_hash, name, email_verified_at, created_at, last_active_at)
     VALUES ($1, 'x', 'Owner', NOW(), NOW() - $2::interval, NOW() - $3::interval) RETURNING id`,
    [`rp-${tag}-${S}@example.com`, age, active]);
  const id = u.rows[0].id;
  await sql.query(
    `INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
     VALUES ($1, 'WS', $2, NOW() + INTERVAL '20 days', ${onboarded ? 'NOW()' : 'NULL'})`, [id, status === 'lapsed' ? 'cancelled' : status]);
  if (ios) await sql`INSERT INTO push_device_tokens (user_id, token, platform) VALUES (${id}, ${`tok-${tag}-${S}`}, 'ios')`;
  for (const [k, v] of Object.entries(cols)) await sql.query(`UPDATE users SET ${k} = ${v} WHERE id = $1`, [id]);
  return id;
}

async function main() {
  await ensureSchemaApplied();
  const due = await owner('due');
  const fresh = await owner('fresh', { age: '2 days' });
  const idle = await owner('idle', { active: '30 days' });
  const web = await owner('web', { ios: false });
  const notOnboarded = await owner('nob', { onboarded: false });
  const lapsed = await owner('lapsed', { status: 'lapsed' });
  const askedRecently = await owner('recent', { cols: { review_prompt_sent_at: "NOW() - INTERVAL '3 days'" } });
  const askedLastWeek = await owner('lastweek', { cols: { review_prompt_sent_at: "NOW() - INTERVAL '8 days'" } });
  const saidYes = await owner('yes', { cols: { review_prompt_answer: "'yes'", review_prompt_answered_at: "NOW() - INTERVAL '30 days'", review_prompt_sent_at: "NOW() - INTERVAL '30 days'" } });
  const saidNoRecent = await owner('norecent', { cols: { review_prompt_answer: "'no'", review_prompt_answered_at: "NOW() - INTERVAL '10 days'", review_prompt_sent_at: "NOW() - INTERVAL '10 days'" } });
  const saidNoLong = await owner('nolong', { cols: { review_prompt_answer: "'no'", review_prompt_answered_at: "NOW() - INTERVAL '40 days'", review_prompt_sent_at: "NOW() - INTERVAL '40 days'" } });
  const ignored4 = await owner('ign4', { cols: { review_prompt_unanswered: '4', review_prompt_sent_at: "NOW() - INTERVAL '10 days'" } });
  const ignored4Long = await owner('ign4long', { cols: { review_prompt_unanswered: '4', review_prompt_sent_at: "NOW() - INTERVAL '31 days'" } });

  console.log('\n[1] who is due');
  const ids = new Set((await dueForReviewPrompt({ limit: 5000 })).map((r) => r.user_id));
  const expect = (id, want, label) => assert(ids.has(id) === want, `${label}: ${want ? 'asked' : 'not asked'}`);
  expect(due, true, 'active iPhone owner, never asked');
  expect(fresh, false, 'account under 7 days old');
  expect(idle, false, 'not active in 14 days');
  expect(web, false, 'no iPhone app');
  expect(notOnboarded, false, 'not onboarded');
  expect(lapsed, false, 'subscription lapsed');
  expect(askedRecently, false, 'asked 3 days ago');
  expect(askedLastWeek, true, 'asked 8 days ago (weekly)');
  expect(saidYes, false, 'said yes 30 days ago (waits 120)');
  expect(saidNoRecent, false, 'said no 10 days ago (waits 30)');
  expect(saidNoLong, true, 'said no 40 days ago');
  expect(ignored4, false, 'ignored 4 in a row, asked 10 days ago (now monthly)');
  expect(ignored4Long, true, 'ignored 4 in a row, asked 31 days ago');

  console.log('\n[2] cron: auth, stamps, sends once');
  const r401 = mkRes(); await cron({ method: 'GET', headers: {}, query: {} }, r401);
  assert(r401.statusCode === 401, 'no secret: 401');
  const r1 = mkRes(); await cron({ method: 'GET', headers: { authorization: 'Bearer cron-review-test' }, query: {} }, r1);
  assert(r1.statusCode === 200 && r1.body.sent >= 4, `sent to the due owners (${JSON.stringify(r1.body)})`);
  const d = (await sql`SELECT review_prompt_sent_at, review_prompt_unanswered FROM users WHERE id = ${due}`).rows[0];
  assert(!!d.review_prompt_sent_at && d.review_prompt_unanswered === 1, 'stamped and counted as unanswered');
  const again = await sendReviewPrompts();
  const stillDue = (await dueForReviewPrompt({ limit: 5000 })).some((r) => r.user_id === due);
  assert(!stillDue && again.sent >= 0, 'not asked again right away');
  assert(PUSH_PAYLOAD.url === '/?ivy_feedback=1' && /Loving Ivy/.test(PUSH_PAYLOAD.title), 'push opens the check-in card');

  process.env.REVIEW_PROMPT_ENABLED = '';
  const off = await sendReviewPrompts();
  assert(off.sent === 0 && /REVIEW_PROMPT_ENABLED/.test(off.skipped || ''), 'switched off: sends nothing');
  process.env.REVIEW_PROMPT_ENABLED = 'true';

  console.log('\n[3] answer endpoint');
  const call = async (userId, body, extra = {}) => {
    const token = await signSession(userId);
    const res = mkRes();
    await answerHandler({ method: 'POST', headers: { cookie: `ivy_session=${token}`, origin: process.env.APP_URL || 'http://localhost', host: 'localhost', ...extra.headers }, body: JSON.stringify(body), url: '/api/me/review-prompt' }, res);
    return res;
  };
  const anon = mkRes();
  await answerHandler({ method: 'POST', headers: {}, body: '{}', url: '/api/me/review-prompt' }, anon);
  assert(anon.statusCode === 401 || anon.statusCode === 403, `signed-out: refused (${anon.statusCode})`);
  let res = await call(due, { answer: 'yes' });
  assert(res.statusCode === 200, `yes accepted (${res.statusCode} ${JSON.stringify(res.body)})`);
  let row = (await sql`SELECT review_prompt_answer, review_prompt_unanswered FROM users WHERE id = ${due}`).rows[0];
  assert(row.review_prompt_answer === 'yes' && row.review_prompt_unanswered === 0, 'yes recorded, unanswered reset');
  res = await call(due, { action: 'review_requested' });
  row = (await sql`SELECT review_prompt_last_action FROM users WHERE id = ${due}`).rows[0];
  assert(res.statusCode === 200 && row.review_prompt_last_action === 'review_requested', 'action recorded');
  res = await call(due, { answer: 'love it' });
  assert(res.statusCode === 400, 'unknown answer rejected');
  res = await call(askedLastWeek, { answer: 'dismissed' });
  row = (await sql`SELECT review_prompt_answer FROM users WHERE id = ${askedLastWeek}`).rows[0];
  assert(res.statusCode === 200 && row.review_prompt_answer == null, 'dismissed does not count as an answer');

  console.log('\n[4] scheduled and copy');
  const crons = JSON.parse(fs.readFileSync('vercel.json', 'utf8')).crons;
  assert(crons.some((c) => c.path === '/api/cron/review-ask'), 'cron scheduled in vercel.json');
  const ui = fs.readFileSync('src/components/ReviewPrompt.jsx', 'utf8');
  assert(/aria-label="Close"/.test(ui) && /Escape/.test(ui) && /e\.target === e\.currentTarget/.test(ui), 'card closes by X, Escape and tapping outside');
  assert(/Not really/.test(ui) && /Talk to support/.test(ui) && /Or leave a review on the App Store/.test(ui), 'No path offers support and still allows a review');
  assert(/Leave a 5-star review/.test(ui) && /Maybe later/.test(ui), 'Yes path asks for 5 stars and can be declined');
  const strings = (ui.match(/'[^']*'|"[^"]*"/g) || []).join(' ');
  assert(!/—/.test(strings) && !/claude|anthropic/i.test(strings), 'no em dashes or vendor names in the copy');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
