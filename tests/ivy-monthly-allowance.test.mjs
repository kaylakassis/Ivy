// Monthly Ivy allowance: 100 messages per workspace per calendar month.
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-monthly-allowance.test.mjs
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-test-not-a-real-key';
process.env.IVY_MONTHLY_MESSAGES = '100';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { generateReply, getDailyUsage, monthlyAllowanceStatus } from '../api/_lib/ivy.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

async function ws(tag) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`allow-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`;
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at) VALUES (${u.rows[0].id}, 'WS', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  return w.rows[0].id;
}
// Seed `n` messages on a given day of the current month (or last month).
async function seed(workspaceId, n, { lastMonth = false, dayOffset = 0 } = {}) {
  await sql`
    INSERT INTO ivy_usage (workspace_id, day, model, request_count, output_tokens)
    VALUES (${workspaceId},
            (date_trunc('month', CURRENT_DATE)::date - ${lastMonth ? 1 : 0}::int * INTERVAL '1 month' + ${dayOffset}::int * INTERVAL '1 day')::date,
            ${'test-model-' + dayOffset + (lastMonth ? '-lm' : '')}, ${n}, 10)`;
}

async function run() {
  await ensureSchemaApplied();
  const a = await ws('a');
  const b = await ws('b');

  console.log('\n[1] fresh workspace');
  let u = await getDailyUsage(a);
  assert(u.monthMessages === 0 && u.monthAllowance === 100, `0/100 to start (${u.monthMessages}/${u.monthAllowance})`);
  assert(/^\d{4}-\d{2}-01T00:00:00/.test(u.monthResetsAt), `resets on the 1st (${u.monthResetsAt})`);
  const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString();
  assert(u.monthResetsAt === nextMonth, 'reset date is the first of next month, UTC');

  console.log('\n[2] usage across the month adds up; last month does not count');
  await seed(a, 60, { lastMonth: true });
  await seed(a, 30, { dayOffset: 0 });
  await seed(a, 69, { dayOffset: 1 });
  let st = await monthlyAllowanceStatus(a);
  assert(st.messages === 99 && st.capped === false, `99 this month, not capped (${st.messages})`);

  console.log('\n[3] the 100th message is the last one; the 101st is refused before any provider call');
  await seed(a, 1, { dayOffset: 2 });
  st = await monthlyAllowanceStatus(a);
  assert(st.messages === 100 && st.capped === true, 'capped at 100');
  const r = await generateReply('hi', {}, [], a);
  assert(r.mode === 'mock' && r.error === 'monthly-allowance', `reply is the allowance notice, not a provider call (${r.error})`);
  assert(/all 100 Ivy messages/.test(r.text) && /fresh 100/.test(r.text), 'notice says how many and that they come back');
  assert(!/claude|anthropic/i.test(r.text), 'notice never names the provider');
  assert(r.usage && r.usage.monthMessages === 100, 'usage returned with the notice for the meter');

  console.log('\n[4] another workspace is unaffected');
  st = await monthlyAllowanceStatus(b);
  assert(st.messages === 0 && !st.capped, 'other workspace at 0');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error('crashed:', e); process.exit(1); });
