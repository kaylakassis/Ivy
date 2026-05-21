// Tests for Email campaigns / newsletters.
//   • resolveAudience: clients / tag / website newsletter, deduped + only
//     real emails.
//   • sendCampaign: opted-out recipients are SKIPPED (not failed),
//     delivered ones counted as sent.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/campaigns.test.mjs

import { sql } from '../api/_lib/db.js';
import { resolveAudience, sendCampaign } from '../api/_lib/campaigns.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const createdUsers = [];
async function mkWorkspace() {
  const u = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`cmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
  createdUsers.push(u.rows[0].id);
  return (await sql`INSERT INTO workspaces (owner_id) VALUES (${u.rows[0].id}) RETURNING id`).rows[0].id;
}
const emails = (list) => list.map((r) => r.email).sort();

async function run() {
  try {
    console.log('\n[resolveAudience]');
    const wid = await mkWorkspace();
    await sql`INSERT INTO clients (workspace_id, name, email, stage, tags) VALUES
      (${wid}, 'C1', 'c1@example.com', 'active', ${['vip']}),
      (${wid}, 'C1b', 'C1@EXAMPLE.com', 'active', ${[]}),
      (${wid}, 'C2', 'c2@example.com', 'active', ${[]}),
      (${wid}, 'C3', '', 'lead', ${[]})`;
    const web = await sql`INSERT INTO websites (workspace_id, handle) VALUES (${wid}, ${`h${Date.now()}`}) RETURNING id`;
    await sql`INSERT INTO website_form_submissions (website_id, form_id, payload) VALUES
      (${web.rows[0].id}, 'newsletter', ${JSON.stringify({ email: 'n1@example.com', name: 'N' })}::jsonb),
      (${web.rows[0].id}, 'contact',    ${JSON.stringify({ email: 'x@example.com' })}::jsonb)`;

    assert(JSON.stringify(emails(await resolveAudience(wid, 'all-clients'))) === JSON.stringify(['c1@example.com', 'c2@example.com']),
      'all-clients: real emails only, deduped case-insensitively');
    assert(JSON.stringify(emails(await resolveAudience(wid, 'tag:vip'))) === JSON.stringify(['c1@example.com']),
      'tag:vip: only tagged clients');
    assert(JSON.stringify(emails(await resolveAudience(wid, 'newsletter'))) === JSON.stringify(['n1@example.com']),
      'newsletter: only newsletter-form emails (contact excluded)');

    console.log('\n[sendCampaign] opt-out honored');
    const wid2 = await mkWorkspace();
    await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid2}, 'A', 'a@example.com', 'active')`;
    await sql`INSERT INTO clients (workspace_id, name, email, stage, notification_prefs)
      VALUES (${wid2}, 'B', 'b@example.com', 'active', ${JSON.stringify({ marketing: false })}::jsonb)`;

    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'em_1' }) });
    let result;
    try {
      result = await sendCampaign({ workspaceId: wid2, campaign: { subject: 'Hi', body: 'Hello!', audience: 'all-clients' } });
    } finally { globalThis.fetch = realFetch; }

    assert(result.recipientCount === 2, 'recipientCount counts both clients');
    assert(result.sent === 1, 'one delivered (A)');
    assert(result.skipped === 1, 'opted-out B is SKIPPED, not failed');
    assert(result.failed === 0, 'no failures');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of createdUsers) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
