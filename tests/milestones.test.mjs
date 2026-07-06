// Tests api/_lib/milestones.js: first-booking and first-payment milestones
// fire exactly once, into the owner's notification feed, and ignore sample
// (source='demo') bookings.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/milestones.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import {
  celebrateFirstBooking, celebrateFirstPayment,
  celebrateBookingMilestones, celebrateReviewMilestones, celebrateRevenueMonthMilestone,
} from '../api/_lib/milestones.js';
import { touchStreak } from '../api/_lib/streak.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const countNotif = async (uid, tag) =>
  Number((await sql`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${uid} AND tag = ${tag}`).rows[0].n);

async function run() {
  try {
    await ensureSchemaApplied();
    const tag = `ms-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;

    console.log('\n[1] first booking fires once');
    // Sample/demo booking should NOT count toward the milestone.
    const demoCli = (await sql`INSERT INTO clients (workspace_id, name, source, stage)
      VALUES (${ws}, 'Demo', 'demo', 'active') RETURNING id`).rows[0].id;
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${ws}, ${demoCli}, 'Demo', 'demo@example.com', CURRENT_DATE, 600, 660)`;
    await celebrateFirstBooking(ws);
    assert(await countNotif(uid, 'milestone-first-booking') === 0, 'demo booking does not trigger milestone');

    // First real booking → fires.
    const realCli = (await sql`INSERT INTO clients (workspace_id, name, stage)
      VALUES (${ws}, 'Real Rita', 'active') RETURNING id`).rows[0].id;
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${ws}, ${realCli}, 'Real Rita', 'rita@example.com', CURRENT_DATE, 660, 720)`;
    await celebrateFirstBooking(ws);
    assert(await countNotif(uid, 'milestone-first-booking') === 1, 'first real booking fires the milestone');

    // Second real booking → does NOT fire again.
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${ws}, ${realCli}, 'Real Rita', 'rita@example.com', CURRENT_DATE, 720, 780)`;
    await celebrateFirstBooking(ws);
    assert(await countNotif(uid, 'milestone-first-booking') === 1, 'second booking does not re-fire');

    console.log('\n[2] first payment fires once');
    await celebrateFirstPayment(ws); // no paid invoices yet
    assert(await countNotif(uid, 'milestone-first-payment') === 0, 'no payment, no milestone');

    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status, paid_at)
      VALUES (${ws}, 'PAID-1', ${realCli}, 'Real Rita',
              ${JSON.stringify([{ description: 'x', quantity: 1, rate: 100 }])}::jsonb, 'paid', NOW())`;
    await celebrateFirstPayment(ws);
    assert(await countNotif(uid, 'milestone-first-payment') === 1, 'first paid invoice fires the milestone');

    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status, paid_at)
      VALUES (${ws}, 'PAID-2', ${realCli}, 'Real Rita',
              ${JSON.stringify([{ description: 'y', quantity: 1, rate: 50 }])}::jsonb, 'paid', NOW())`;
    await celebrateFirstPayment(ws);
    assert(await countNotif(uid, 'milestone-first-payment') === 1, 'second payment does not re-fire');

    // ── Repeat / mid-journey milestones (fresh workspace for exact counts) ──
    const uid2 = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}-2@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws2 = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid2}) RETURNING id`).rows[0].id;
    const cli2 = (await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${ws2}, 'Rita', 'active') RETURNING id`).rows[0].id;

    console.log('\n[3] booking milestone fires exactly on the tier (10), once');
    for (let i = 0; i < 9; i++) {
      // eslint-disable-next-line no-await-in-loop
      await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
        VALUES (${ws2}, ${cli2}, 'Rita', 'r@example.com', CURRENT_DATE, ${600 + i}, ${601 + i})`;
    }
    await celebrateBookingMilestones(ws2);
    assert(await countNotif(uid2, 'milestone-bookings-10') === 0, '9 bookings → no tier yet');
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${ws2}, ${cli2}, 'Rita', 'r@example.com', CURRENT_DATE, 700, 701)`;
    await celebrateBookingMilestones(ws2);
    assert(await countNotif(uid2, 'milestone-bookings-10') === 1, '10th booking fires the tier');
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${ws2}, ${cli2}, 'Rita', 'r@example.com', CURRENT_DATE, 710, 711)`;
    await celebrateBookingMilestones(ws2);
    assert(await countNotif(uid2, 'milestone-bookings-10') === 1, '11 bookings → tier does not re-fire');

    console.log('\n[4] review milestone fires on the tier (5), once');
    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop
      await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating) VALUES (${ws2}, 'Rev', 5)`;
    }
    await celebrateReviewMilestones(ws2);
    assert(await countNotif(uid2, 'milestone-reviews-5') === 0, '4 reviews → no tier yet');
    await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating) VALUES (${ws2}, 'Rev', 5)`;
    await celebrateReviewMilestones(ws2);
    assert(await countNotif(uid2, 'milestone-reviews-5') === 1, '5th review fires the tier');

    console.log('\n[5] revenue-month milestone fires the highest reached tier, once');
    await celebrateRevenueMonthMilestone(ws2); // no paid revenue yet
    assert(await countNotif(uid2, 'milestone-revenue-month-1000') === 0, 'no revenue → no tier');
    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status, paid_at)
      VALUES (${ws2}, 'M-1', ${cli2}, 'Rita', ${JSON.stringify([{ description: 'x', quantity: 1, rate: 1200 }])}::jsonb, 'paid', NOW())`;
    await celebrateRevenueMonthMilestone(ws2);
    assert(await countNotif(uid2, 'milestone-revenue-month-1000') === 1, 'a $1.2k month fires the $1k tier');
    assert(await countNotif(uid2, 'milestone-revenue-month-5000') === 0, 'the $5k tier has not been reached');
    // Jump to a $6k+ month → only the highest newly-reached tier ($5k) fires.
    await sql`INSERT INTO invoices (workspace_id, number, client_id, client_name, items, status, paid_at)
      VALUES (${ws2}, 'M-2', ${cli2}, 'Rita', ${JSON.stringify([{ description: 'y', quantity: 1, rate: 5000 }])}::jsonb, 'paid', NOW())`;
    await celebrateRevenueMonthMilestone(ws2);
    assert(await countNotif(uid2, 'milestone-revenue-month-5000') === 1, 'crossing $5k fires the $5k tier');
    assert(await countNotif(uid2, 'milestone-revenue-month-1000') === 1, 'the $1k tier does not re-fire');

    console.log('\n[6] streak personal-best advances and survives a reset');
    const uid3 = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}-3@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const ws3 = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid3}) RETURNING id`).rows[0].id;
    // Active yesterday with a 5-day streak → today advances to 6, best becomes 6.
    await sql`UPDATE workspaces SET streak_days = 5, streak_best = 5, streak_last_day = (CURRENT_DATE - 1) WHERE id = ${ws3}`;
    let sres = await touchStreak(ws3);
    assert(sres.days === 6 && sres.best === 6, `advance → days 6, best 6 (got ${sres.days}/${sres.best})`);
    // Simulate a lapse: last active 3 days ago (stale streak_days) → resets to 1,
    // but the personal best is preserved.
    await sql`UPDATE workspaces SET streak_days = 6, streak_last_day = (CURRENT_DATE - 3) WHERE id = ${ws3}`;
    sres = await touchStreak(ws3);
    assert(sres.days === 1 && sres.best === 6, `reset → days 1 but best still 6 (got ${sres.days}/${sres.best})`);
    const bestCol = Number((await sql`SELECT streak_best FROM workspaces WHERE id = ${ws3}`).rows[0].streak_best);
    assert(bestCol === 6, 'streak_best column persists the personal best');

    // Cleanup
    await sql`DELETE FROM notifications WHERE user_id = ${uid}`;
    await sql`DELETE FROM invoices WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM bookings WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM clients WHERE workspace_id = ${ws}`;
    await sql`DELETE FROM workspaces WHERE id = ${ws}`;
    await sql`DELETE FROM users WHERE id = ${uid}`;
    await sql`DELETE FROM notifications WHERE user_id = ${uid2}`;
    await sql`DELETE FROM reviews WHERE workspace_id = ${ws2}`;
    await sql`DELETE FROM invoices WHERE workspace_id = ${ws2}`;
    await sql`DELETE FROM bookings WHERE workspace_id = ${ws2}`;
    await sql`DELETE FROM clients WHERE workspace_id = ${ws2}`;
    await sql`DELETE FROM workspaces WHERE id = ${ws2}`;
    await sql`DELETE FROM users WHERE id = ${uid2}`;
    await sql`DELETE FROM workspaces WHERE id = ${ws3}`;
    await sql`DELETE FROM users WHERE id = ${uid3}`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
