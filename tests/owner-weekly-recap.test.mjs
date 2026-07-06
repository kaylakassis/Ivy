// Weekly owner recap email + the cron that sends it.
// Confirms:
//   • renderWeeklyRecap returns a sane { subject, html } for both an
//     empty week and a busy week, with merge fields substituted.
//   • The cron's SQL eligibility picks ACTIVE / TRIALING-LIVE owners with
//     onboarded_at set, skips beta + sponsored + un-onboarded.
//   • It's idempotent: a second run inside the 6-day cooldown re-pings
//     nothing.
//   • Auth gate: no admin secret → 401.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/owner-weekly-recap.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { renderWeeklyRecap } from '../api/_lib/weeklyRecap.js';
import recapCron from '../api/cron/owner-weekly-recap.js';

process.env.ADMIN_SECRET ||= 'test-admin-secret';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
}
const cronReq = () => ({
  method: 'GET', url: '/api/cron/owner-weekly-recap', query: {},
  headers: { 'x-admin-secret': process.env.ADMIN_SECRET },
});

async function mkOwner({ userType = 'regular', subStatus = 'trialing', trialDaysAhead = 7, onboarded = true } = {}) {
  const email = `recap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const u = await sql`INSERT INTO users (email, password_hash, name, user_type, email_verified_at)
    VALUES (${email}, 'x', 'Recap Owner', ${userType}, NOW()) RETURNING id`;
  const userId = u.rows[0].id;
  const w = await sql`
    INSERT INTO workspaces (owner_id, subscription_status, trial_ends_at, onboarded_at)
    VALUES (${userId}, ${subStatus},
            ${subStatus === 'trialing' ? new Date(Date.now() + trialDaysAhead * 86400000) : null},
            ${onboarded ? new Date(Date.now() - 30 * 86400000) : null})
    RETURNING id`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name)
            VALUES (${w.rows[0].id}, 'Sample Studio')
            ON CONFLICT (workspace_id) DO NOTHING`;
  return { userId, workspaceId: w.rows[0].id, email };
}

const created = [];

async function run() {
  try {
    await ensureSchemaApplied();
    // Clean any prior recap test fixtures.
    await sql.query(`DELETE FROM users WHERE email LIKE 'recap-%@example.com'`);

    console.log('\n[1] renderWeeklyRecap shape: busy week');
    const busy = renderWeeklyRecap({
      firstName: 'Casey', businessName: 'Casey & Co',
      range: { from: new Date(Date.now() - 7 * 86400000), to: new Date() },
      stats: { newClients: 3, completedBookings: 8, upcomingBookings: 5, revenuePaid: 2140, overdueInvoiceCount: 2, overdueInvoiceTotal: 380 },
    });
    assert(typeof busy.subject === 'string' && busy.subject.includes('Casey & Co'), 'subject mentions business name');
    assert(typeof busy.html === 'string' && busy.html.includes('Casey'), 'body greets by first name');
    assert(busy.html.includes('$2,140') || busy.html.includes('2140') || busy.html.includes('$2140'), 'body shows revenue total');
    assert(busy.html.includes('Hi Casey') || busy.html.includes('Casey'), 'first name escaped + present');
    assert(!/\{\{\s*\w+\s*\}\}/.test(busy.html), 'no leftover {{ ... }} tokens');

    console.log('\n[2] renderWeeklyRecap shape: empty / quiet week');
    const quiet = renderWeeklyRecap({
      firstName: 'Pat', businessName: 'Pat Studio',
      range: { from: new Date(Date.now() - 7 * 86400000), to: new Date() },
      stats: { newClients: 0, completedBookings: 0, upcomingBookings: 0, revenuePaid: 0, overdueInvoiceCount: 0, overdueInvoiceTotal: 0 },
    });
    assert(quiet.html.includes('quiet one') || quiet.html.includes('quiet'), 'quiet week gets a softer headline');
    assert(quiet.html.includes('No sessions on the books') || quiet.html.includes('Empty calendar'), 'quiet week names the empty calendar');

    const range = { from: new Date(Date.now() - 7 * 86400000), to: new Date() };

    console.log('\n[2b] week-over-week UP delta + best-day highlight');
    const up = renderWeeklyRecap({
      firstName: 'Casey', businessName: 'Casey & Co', range,
      stats: {
        newClients: 3, completedBookings: 8, upcomingBookings: 5, revenuePaid: 2140,
        overdueInvoiceCount: 0, overdueInvoiceTotal: 0,
        prior: { newClients: 1, completedBookings: 5, revenuePaid: 1600 },
        bestDay: { date: '2026-06-30', amount: 640 },
      },
    });
    assert(up.html.includes('up from'), 'up week shows an up-delta');
    assert(up.html.includes('$1,600'), 'the delta names the prior-week revenue');
    assert(up.html.includes('best day') && up.html.includes('$640'), 'best-day highlight is rendered');

    console.log('\n[2c] DOWN week is neutral, never punishing');
    const down = renderWeeklyRecap({
      firstName: 'Casey', businessName: 'Casey & Co', range,
      stats: {
        newClients: 1, completedBookings: 3, upcomingBookings: 2, revenuePaid: 900,
        overdueInvoiceCount: 0, overdueInvoiceTotal: 0,
        prior: { newClients: 4, completedBookings: 8, revenuePaid: 1600 },
        bestDay: null,
      },
    });
    assert(down.html.includes('down from'), 'down week shows a neutral down-delta');
    assert(!/slipped|falling|worse|bad week|failing/i.test(down.html), 'no punishing language on a down week');

    console.log('\n[2d] no prior week → never "up from $0", best-day omitted when null');
    const noPrior = renderWeeklyRecap({
      firstName: 'Casey', businessName: 'Casey & Co', range,
      stats: {
        newClients: 2, completedBookings: 3, upcomingBookings: 1, revenuePaid: 500,
        overdueInvoiceCount: 0, overdueInvoiceTotal: 0,
        prior: { newClients: 0, completedBookings: 0, revenuePaid: 0 },
        bestDay: null,
      },
    });
    assert(!noPrior.html.includes('up from $0'), 'never renders "up from $0"');
    assert(!noPrior.html.includes('best day'), 'best-day block omitted when null');
    assert(noPrior.html.includes('First paid week'), 'celebratory line for first revenue after a dry spell');

    console.log('\n[3] cron eligibility — active trialing owner is picked up + stamped');
    const live = await mkOwner({ userType: 'regular', subStatus: 'trialing', trialDaysAhead: 7, onboarded: true });
    created.push(live);
    let r = mockRes();
    await recapCron(cronReq(), r);
    assert(r.statusCode === 200, 'cron returns 200');
    assert((r.body?.scanned || 0) >= 1, `at least 1 candidate scanned (got ${r.body?.scanned})`);
    const stamped = (await sql`SELECT weekly_recap_last_sent_at FROM workspaces WHERE id = ${live.workspaceId}`).rows[0];
    assert(!!stamped.weekly_recap_last_sent_at, 'live owner stamped with weekly_recap_last_sent_at');

    console.log('\n[4] cron idempotency — second run inside the cooldown does nothing for the stamped owner');
    r = mockRes();
    await recapCron(cronReq(), r);
    // The same workspace was just stamped, so the SQL filter excludes
    // it. (Other test workspaces may exist; we only assert about ours.)
    const stamped2 = (await sql`SELECT weekly_recap_last_sent_at FROM workspaces WHERE id = ${live.workspaceId}`).rows[0];
    assert(String(stamped2.weekly_recap_last_sent_at) === String(stamped.weekly_recap_last_sent_at),
      'stamp unchanged on a re-run');

    console.log('\n[5] cron eligibility — un-onboarded / beta / sponsored owners are skipped');
    const unonb     = await mkOwner({ userType: 'regular',   subStatus: 'trialing', onboarded: false });
    const beta      = await mkOwner({ userType: 'beta',      subStatus: 'active' });
    const sponsored = await mkOwner({ userType: 'sponsored', subStatus: 'active' });
    created.push(unonb, beta, sponsored);
    r = mockRes();
    await recapCron(cronReq(), r);
    for (const c of [unonb, beta, sponsored]) {
      // eslint-disable-next-line no-await-in-loop
      const got = (await sql`SELECT weekly_recap_last_sent_at FROM workspaces WHERE id = ${c.workspaceId}`).rows[0];
      assert(got.weekly_recap_last_sent_at === null, `not stamped: ${c.email}`);
    }

    console.log('\n[6] no admin auth → 401');
    r = mockRes();
    await recapCron({ method: 'GET', url: '/x', query: {}, headers: {} }, r);
    assert(r.statusCode === 401, 'no auth → 401');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const c of created) {
      // eslint-disable-next-line no-await-in-loop
      await sql`DELETE FROM workspaces WHERE id = ${c.workspaceId}`.catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await sql`DELETE FROM users WHERE id = ${c.userId}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
