// Ivy proactive agent (P2): detectors → pending ivy_suggestions, idempotency,
// resolve, and strict workspace isolation.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-agent.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import {
  runIvyAgentForWorkspace, listPendingSuggestions, resolveSuggestion,
} from '../api/_lib/ivyAgent.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const EMAIL = `ivy-agent-${Date.now()}@example.com`;
const EMAIL2 = `ivy-agent-other-${Date.now()}@example.com`;
let wsA, wsB;

async function run() {
  try {
    await ensureSchemaApplied();
    const oA = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL}, 'x', 'A') RETURNING id`).rows[0].id;
    wsA = (await sql`INSERT INTO workspaces (owner_id) VALUES (${oA}) RETURNING id`).rows[0].id;
    const oB = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL2}, 'x', 'B') RETURNING id`).rows[0].id;
    wsB = (await sql`INSERT INTO workspaces (owner_id) VALUES (${oB}) RETURNING id`).rows[0].id;

    // Seed 4 distinct signals in workspace A:
    // overdue invoice, fresh 5-star review, an aging unreplied lead, quiet calendar.
    await sql`INSERT INTO invoices (workspace_id, number, client_name, status, items, tax_rate, discount, currency)
              VALUES (${wsA}, ${'OD-' + Date.now()}, 'Acme', 'overdue', ${JSON.stringify([{ quantity: 1, rate: 200 }])}::jsonb, 0, 0, 'USD')`;
    await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text) VALUES (${wsA}, 'Sarah', 5, 'Amazing')`;
    await sql`INSERT INTO clients (workspace_id, name, email, stage, created_at)
              VALUES (${wsA}, 'Old Lead', 'ol@x.com', 'lead', NOW() - INTERVAL '2 days')`;
    // 3 active clients + 0 upcoming bookings → calendar_gap fires.
    for (const n of ['Amy', 'Ben', 'Cara']) {
      await sql`INSERT INTO clients (workspace_id, name, stage) VALUES (${wsA}, ${n}, 'active')`;
    }

    console.log('\n[1] agent detects all four signals');
    const r1 = await runIvyAgentForWorkspace(wsA);
    assert(r1.created === 4, `created 4 suggestions (got ${r1.created})`);
    const list = await listPendingSuggestions(wsA);
    const kinds = new Set(list.map((s) => s.kind));
    assert(['overdue_invoices', 'new_review', 'unreplied_leads', 'calendar_gap'].every((k) => kinds.has(k)),
      'all four kinds present');
    assert(list.every((s) => typeof s.prompt === 'string' && s.prompt.length > 0), 'each has an actionable prompt');

    console.log('\n[2] idempotent — re-running the same day creates nothing new');
    const r2 = await runIvyAgentForWorkspace(wsA);
    assert(r2.created === 0, 're-run creates 0 (dedupe_key holds)');
    assert((await listPendingSuggestions(wsA)).length === 4, 'still exactly 4 pending');

    console.log('\n[3] resolve removes a suggestion; scoped to the workspace');
    const target = list[0];
    const okResolve = await resolveSuggestion(wsA, target.id, 'dismiss');
    assert(okResolve === true, 'own suggestion resolves');
    assert((await listPendingSuggestions(wsA)).length === 3, 'now 3 pending');
    // Another workspace cannot resolve wsA's suggestion.
    const crossResolve = await resolveSuggestion(wsB, list[1].id, 'dismiss');
    assert(crossResolve === false, 'cannot resolve another workspace\'s suggestion');
    assert((await listPendingSuggestions(wsA)).length === 3, 'wsA still 3 (cross-resolve had no effect)');

    console.log('\n[3b] one card per signal, and cards retire once the owner has handled them');
    // Yesterday's still-pending lead card (a day-keyed signal that was true two days running).
    await sql`INSERT INTO ivy_suggestions (workspace_id, kind, dedupe_key, title, prompt, created_at)
              VALUES (${wsA}, 'unreplied_leads', 'leads:2000-01-01', 'stale', 'x', NOW() - INTERVAL '1 day')`;
    let leadCards = (await listPendingSuggestions(wsA)).filter((x) => x.kind === 'unreplied_leads');
    assert(leadCards.length === 1 && leadCards[0].title !== 'stale', 'list shows a single, newest lead card even with a stale duplicate pending');
    await runIvyAgentForWorkspace(wsA);
    const stale = (await sql`SELECT status FROM ivy_suggestions WHERE workspace_id = ${wsA} AND dedupe_key = 'leads:2000-01-01'`).rows[0];
    assert(stale?.status === 'done', 'the agent retires the older pending card of the same kind');
    // The owner replies to the lead: the card goes away on the next dashboard load.
    const lead = (await sql`SELECT id FROM clients WHERE workspace_id = ${wsA} AND name = 'Old Lead'`).rows[0];
    const th = await sql`INSERT INTO message_threads (workspace_id, client_id) VALUES (${wsA}, ${lead.id}) RETURNING id`;
    await sql`INSERT INTO messages (thread_id, sender, text) VALUES (${th.rows[0].id}, 'biz', 'Hi! Thanks for reaching out.')`;
    leadCards = (await listPendingSuggestions(wsA)).filter((x) => x.kind === 'unreplied_leads');
    assert(leadCards.length === 0, 'lead card disappears once the owner has replied');
    const retired = (await sql`SELECT status FROM ivy_suggestions WHERE workspace_id = ${wsA} AND kind = 'unreplied_leads' ORDER BY created_at DESC LIMIT 1`).rows[0];
    assert(retired?.status === 'done', 'it is marked done, not left pending');
    assert((await listPendingSuggestions(wsA)).some((x) => x.kind === 'new_review'), 'the review card is untouched');

    console.log('\n[4] an empty workspace produces nothing and leaks nothing');
    const rB = await runIvyAgentForWorkspace(wsB);
    assert(rB.created === 0, 'empty workspace creates 0 suggestions');
    assert((await listPendingSuggestions(wsB)).length === 0, 'wsB sees no suggestions (isolation)');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const e of [EMAIL, EMAIL2]) {
      await sql`DELETE FROM workspaces WHERE owner_id = (SELECT id FROM users WHERE email = ${e})`.catch(() => {});
      await sql`DELETE FROM users WHERE email = ${e}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
