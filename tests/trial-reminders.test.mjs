// Trial-ending reminder drip. Confirms the paywall-promised ~2-day heads-up now
// exists and renders, the stage windows are DISJOINT (a trial matches exactly
// one stage per run — no double emails), each stamp is one-shot, and the copy
// renders for every stage.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/trial-reminders.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { renderTrialReminder } from '../api/_lib/subscriptionNotify.js';

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron';
const { default: trialReminders } = await import('../api/cron/trial-reminders.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mkRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader() {}, json(o) { this.body = o; return this; }, end() { return this; },
  };
}
const cronReq = () => ({ method: 'POST', url: '/api/cron/trial-reminders', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

// A trialing workspace whose trial ends `endInDays` from now.
async function mkTrial(tag, endInDays) {
  const uid = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', 'Trial Owner', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at)
    VALUES (${uid}, 'trialing', NOW() + (${String(endInDays)} || ' days')::interval) RETURNING id`).rows[0].id;
  return { uid, ws };
}
const stamps = async (ws) => (await sql`
  SELECT trial_reminder_7d_sent_at AS d7, trial_reminder_2d_sent_at AS d2,
         trial_reminder_1d_sent_at AS d1, trial_expired_notice_sent_at AS exp
    FROM workspaces WHERE id = ${ws}`).rows[0];

async function run() {
  const created = [];
  try {
    await ensureSchemaApplied();
    const tag = `trem-${Date.now()}`;
    const track = (o) => { created.push(o); return o; };

    console.log('\n[1] renderTrialReminder covers the 2-day stage (and unknown → null)');
    const r2 = renderTrialReminder({ stage: '2d', trialEndsAt: new Date(Date.now() + 2 * 86400000), firstName: 'Casey', businessName: 'Casey & Co' });
    assert(!!r2 && /2 days/.test(r2.subject), `2d subject mentions "2 days" (got ${r2?.subject})`);
    assert(/no charge|no surprise|cancel/i.test(r2.html), '2d body reassures about no surprise charge');
    assert(renderTrialReminder({ stage: '2d', trialEndsAt: new Date() }).html.length > 0, '2d renders HTML');
    assert(renderTrialReminder({ stage: 'nope', trialEndsAt: new Date() }) === null, 'unknown stage still returns null');

    console.log('\n[2] disjoint windows → each trial matches exactly one stage');
    const w7 = track(await mkTrial(`${tag}-7`, 5));    // ~5 days out → 7d only
    const w2 = track(await mkTrial(`${tag}-2`, 1.5));   // ~1.5 days out → 2d only
    const w1 = track(await mkTrial(`${tag}-1`, 0.5));   // ~0.5 days out → 1d only
    const res = mkRes();
    await trialReminders(cronReq(), res);
    assert(res.statusCode === 200, `cron ok (got ${res.statusCode})`);

    const s7 = await stamps(w7.ws);
    assert(s7.d7 && !s7.d2 && !s7.d1, 'a ~5-day trial fires ONLY the 7-day stage');
    const s2 = await stamps(w2.ws);
    assert(s2.d2 && !s2.d7 && !s2.d1, 'a ~1.5-day trial fires ONLY the new 2-day stage');
    const s1 = await stamps(w1.ws);
    assert(s1.d1 && !s1.d2 && !s1.d7, 'a ~0.5-day trial fires ONLY the 1-day stage');

    console.log('\n[3] one-shot: a second run does not re-stamp');
    const before = (await stamps(w2.ws)).d2;
    await trialReminders(cronReq(), mkRes());
    assert(String((await stamps(w2.ws)).d2) === String(before), 'the 2-day stamp is unchanged on a re-run');

    console.log('\n[4] auth gate');
    const noAuth = mkRes();
    await trialReminders({ method: 'POST', headers: {} }, noAuth);
    assert(noAuth.statusCode === 401, `no cron secret → 401 (got ${noAuth.statusCode})`);
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const o of created) {
      await sql`DELETE FROM workspaces WHERE id = ${o.ws}`;
      await sql`DELETE FROM users WHERE id = ${o.uid}`;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
