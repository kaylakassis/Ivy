// Plan-ending reminder: an owner who turned auto-renew off gets one email +
// push ~2 days before access ends, saying the booking page, website and
// client portal will be archived. Never twice, never for renewing plans.
// Run: node --import ./tests/bootstrap.mjs ./tests/plan-ending.test.mjs
process.env.CRON_SECRET = 'cron-test-secret';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import handler from '../api/cron/plan-ending.js';
import { renderPlanEnding, renderSubscriptionCancelled } from '../api/_lib/subscriptionNotify.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

async function ws(tag, { cancel = true, endsIn = '1 day', status = 'active' } = {}) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`pe-${tag}-${S}@example.com`}, 'x', 'Owner Name', NOW()) RETURNING id`;
  const w = await sql.query(
    `INSERT INTO workspaces (owner_id, name, subscription_status, subscription_source, subscription_period_end, cancel_at_period_end, onboarded_at)
     VALUES ($1, 'WS', $2, 'stripe', NOW() + $3::interval, $4, NOW()) RETURNING id`,
    [u.rows[0].id, status, endsIn, cancel],
  );
  return w.rows[0].id;
}
const mkRes = () => { const r = { statusCode: 200, body: null, setHeader() {}, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; };
const run = async (headers = { authorization: 'Bearer cron-test-secret' }) => { const res = mkRes(); await handler({ method: 'GET', headers, query: {}, url: '/api/cron/plan-ending' }, res); return res; };

async function main() {
  await ensureSchemaApplied();
  const due = await ws('due');                                  // cancelling, ends tomorrow
  const far = await ws('far', { endsIn: '10 days' });            // cancelling, too early
  const renewing = await ws('renew', { cancel: false });         // not cancelling
  const lapsed = await ws('lapsed', { endsIn: '-1 day', status: 'canceled' });

  console.log('\n[1] auth');
  const r0 = await run({});
  assert(r0.statusCode === 401, `no secret → 401 (${r0.statusCode})`);

  console.log('\n[2] only the cancelling workspace inside the window is reminded');
  const r1 = await run();
  assert(r1.statusCode === 200 && r1.body.sent >= 1, `ran and sent (${JSON.stringify(r1.body)})`);
  const stamps = async (id) => (await sql`SELECT plan_ending_reminder_sent_at FROM workspaces WHERE id = ${id}`).rows[0].plan_ending_reminder_sent_at;
  assert(!!(await stamps(due)), 'due workspace stamped');
  assert(!(await stamps(far)), 'workspace 10 days out not stamped');
  assert(!(await stamps(renewing)), 'renewing workspace not stamped');
  assert(!(await stamps(lapsed)), 'already lapsed workspace not stamped');
  const notif = (await sql`SELECT title, body, url FROM notifications WHERE workspace_id = ${due} AND type = 'payments' ORDER BY created_at DESC LIMIT 1`).rows[0];
  assert(!!notif && /plan ends/i.test(notif.title) && /archived/.test(notif.body) && notif.url === '/account?tab=billing', `in-app notice written (${notif?.title})`);

  console.log('\n[3] a second run sends nothing more');
  const r2 = await run();
  assert(r2.body.sent === 0, `second run sent 0 (${r2.body.sent})`);

  console.log('\n[4] turning renewal back on clears the stamp (webhook behaviour mirrored)');
  await sql`UPDATE workspaces SET cancel_at_period_end = FALSE, plan_ending_reminder_sent_at = NULL WHERE id = ${due}`;
  const r3 = await run();
  assert(r3.body.sent === 0, 'renewing again → no reminder');

  console.log('\n[5] copy');
  const e = renderPlanEnding({ endsAt: new Date(Date.now() + 2 * 864e5), firstName: 'Kay', businessName: 'Glow Studio', source: 'stripe' });
  assert(/plan ends on/.test(e.subject), `subject names the date (${e.subject})`);
  assert(/booking page and website/.test(e.html) && /client portal/.test(e.html) && /7 days/.test(e.html) && /permanently deleted/.test(e.html), 'email says what is archived and that data is deleted 7 days later');
  assert(/Keep my plan/.test(e.html), 'Stripe CTA keeps the plan');
  const a = renderPlanEnding({ endsAt: new Date(), firstName: 'Kay', businessName: 'Glow', source: 'apple' });
  assert(/App Store/.test(a.html) && /apps\.apple\.com\/account\/subscriptions/.test(a.html), 'Apple-billed CTA goes to the App Store');
  const c = renderSubscriptionCancelled({ endsAt: new Date(), firstName: 'Kay', businessName: 'Glow' });
  assert(/archived/.test(c.html) && !/free account/.test(c.html), 'cancellation email mentions the archive, not a "free account"');
  assert(!/<script|claude|anthropic/i.test(e.html + a.html + c.html), 'no scripts, no vendor names');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
