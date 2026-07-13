// Ivy P3 read tools: list_reviews + list_leads. Confirms Ivy can see her
// reputation (ratings, unanswered reviews) and her leads (age, contacted),
// both strictly workspace-scoped.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/ivy-reviews-leads.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const EMAIL = `ivy-rl-${Date.now()}@example.com`;
const EMAIL2 = `ivy-rl-other-${Date.now()}@example.com`;
let workspaceId, otherWs;

async function run() {
  try {
    await ensureSchemaApplied();
    const o1 = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL}, 'x', 'RL') RETURNING id`).rows[0].id;
    workspaceId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${o1}) RETURNING id`).rows[0].id;
    const o2 = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL2}, 'x', 'Other') RETURNING id`).rows[0].id;
    otherWs = (await sql`INSERT INTO workspaces (owner_id) VALUES (${o2}) RETURNING id`).rows[0].id;

    // Reviews: a responded 5-star + an unanswered 2-star (this ws), plus a
    // 1-star for the OTHER ws that must never appear.
    await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text, owner_response, owner_responded_at)
              VALUES (${workspaceId}, 'Happy Sarah', 5, 'Loved it', 'Thank you!', NOW())`;
    await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text)
              VALUES (${workspaceId}, 'Grumpy Gus', 2, 'Meh')`;
    await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text) VALUES (${otherWs}, 'Nope', 1, 'not mine')`;

    console.log('\n[1] list_reviews: this workspace only, correct aggregates');
    const rv = await executeIvyTool('list_reviews', {}, { workspaceId });
    assert(rv.reviews.length === 2, 'exactly this workspace\'s 2 reviews');
    assert(!rv.reviews.some((r) => r.reviewer_name === 'Nope'), 'never includes the other workspace\'s review');
    assert(rv.total === 2 && rv.average_rating === 3.5, 'total 2, avg (5+2)/2 = 3.5');
    assert(rv.positive_count === 1 && rv.negative_count === 1, '1 positive (>=4), 1 negative (<=2)');
    assert(rv.unresponded_count === 1, 'only the 2-star is unanswered');

    // Leads: 2 leads + 1 ACTIVE client (excluded) for this ws; 1 lead for other ws.
    await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${workspaceId}, 'Lead One', 'l1@x.com', 'lead')`;
    await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${workspaceId}, 'Lead Two', 'l2@x.com', 'lead')`;
    await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${workspaceId}, 'Active Amy', 'a@x.com', 'active')`;
    await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${otherWs}, 'Other Lead', 'ol@x.com', 'lead')`;

    console.log('\n[2] list_leads: only stage=lead in this workspace, contacted flag present');
    const ld = await executeIvyTool('list_leads', {}, { workspaceId });
    assert(ld.leads.length === 2, 'exactly the 2 leads (active client excluded)');
    assert(!ld.leads.some((l) => l.name === 'Active Amy'), 'active client not treated as a lead');
    assert(!ld.leads.some((l) => l.name === 'Other Lead'), 'other workspace\'s lead not included');
    assert(ld.uncontacted_count === 2, 'both leads uncontacted (no biz message yet)');
    assert(ld.leads.every((l) => typeof l.contacted === 'boolean' && typeof l.days_old === 'number'), 'each lead has contacted + days_old');
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
