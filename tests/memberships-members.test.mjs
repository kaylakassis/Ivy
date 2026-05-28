// Tests GET /api/memberships/members — owner-side list of every
// client_memberships row in the workspace. Validates workspace scoping
// (no cross-tenant leak), auth gate, and the serialized shape the
// Memberships UI consumes.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/memberships-members.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_local_dev_only_at_least_32_chars';

const { default: handler } = await import('../api/memberships/members.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s)  { this.body = s; return this; },
  };
}
function authReq(cookieHeader) {
  return {
    method: 'GET', url: '/api/memberships/members',
    headers: {
      origin: 'http://localhost:3000', host: 'localhost:3000',
      cookie: cookieHeader || '',
    },
  };
}

async function run() {
  try {
    await ensureSchemaApplied();

    const tag = `mm-${Date.now()}`;
    const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
      VALUES (${`${tag}@example.com`}, 'x', 'Owner', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${wid}, 'Alice', ${`${tag}-a@example.com`}, 'active') RETURNING id`).rows[0].id;
    const cid2 = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${wid}, 'Bob', ${`${tag}-b@example.com`}, 'active') RETURNING id`).rows[0].id;
    const mid = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active)
      VALUES (${wid}, 'Plat', 2500, 'month', TRUE) RETURNING id`).rows[0].id;
    await sql`INSERT INTO client_memberships (workspace_id, client_id, membership_id,
      membership_name, price_cents, interval, status, stripe_subscription_id)
      VALUES (${wid}, ${cid}, ${mid}, 'Plat', 2500, 'month', 'active', 'sub_alice')`;
    await sql`INSERT INTO client_memberships (workspace_id, client_id, membership_id,
      membership_name, price_cents, interval, status, stripe_subscription_id)
      VALUES (${wid}, ${cid2}, ${mid}, 'Plat', 2500, 'month', 'cancelled', null)`;

    // Cross-tenant fixture
    const otherU = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`${tag}-other@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
    const otherW = (await sql`INSERT INTO workspaces (owner_id) VALUES (${otherU}) RETURNING id`).rows[0].id;
    const otherC = (await sql`INSERT INTO clients (workspace_id, name, email, stage)
      VALUES (${otherW}, 'Eve', ${`${tag}-eve@example.com`}, 'active') RETURNING id`).rows[0].id;
    const otherM = (await sql`INSERT INTO memberships (workspace_id, name, price_cents, interval, active)
      VALUES (${otherW}, 'Other', 100, 'month', TRUE) RETURNING id`).rows[0].id;
    await sql`INSERT INTO client_memberships (workspace_id, client_id, membership_id,
      membership_name, price_cents, interval, status, stripe_subscription_id)
      VALUES (${otherW}, ${otherC}, ${otherM}, 'Other', 100, 'month', 'active', 'sub_eve')`;

    console.log('\n[1] unauthenticated → 401');
    const r0 = mkRes(); await handler(authReq(''), r0);
    assert(r0.statusCode === 401, `no cookie → 401 (got ${r0.statusCode})`);

    console.log('\n[2] authenticated returns this workspace only');
    const cookie = `thryve_session=${signSession(uid)}`;
    const r1 = mkRes(); await handler(authReq(cookie), r1);
    assert(r1.statusCode === 200, `200 (got ${r1.statusCode})`);
    const members = r1.body?.members || [];
    assert(members.length === 2, `returns 2 members from this workspace (got ${members.length})`);
    assert(members.every((m) => m.membershipName === 'Plat'), 'all returned rows belong to this workspace tier');
    const emails = members.map((m) => m.clientEmail).sort();
    assert(!emails.includes(`${tag}-eve@example.com`), 'no cross-tenant leak from other workspace');

    console.log('\n[3] active sorts before cancelled');
    assert(members[0].status === 'active', `first row is active (got '${members[0].status}')`);

    console.log('\n[4] serialized shape carries everything the UI needs');
    const alice = members.find((m) => m.clientName === 'Alice');
    assert(!!alice, 'Alice row present');
    assert(alice.clientEmail === `${tag}-a@example.com`, 'clientEmail set');
    assert(alice.membershipId === mid, 'membershipId set');
    assert(Number(alice.priceCents) === 2500, 'priceCents set');
    assert(alice.hasStripe === true, 'hasStripe true for sub with stripe_subscription_id');
    const bob = members.find((m) => m.clientName === 'Bob');
    assert(bob.hasStripe === false, 'hasStripe false for cancelled sub with no stripe_subscription_id');

    // Cleanup
    await sql`DELETE FROM client_memberships WHERE workspace_id IN (${wid}, ${otherW})`;
    await sql`DELETE FROM memberships WHERE workspace_id IN (${wid}, ${otherW})`;
    await sql`DELETE FROM clients WHERE workspace_id IN (${wid}, ${otherW})`;
    await sql`DELETE FROM workspaces WHERE id IN (${wid}, ${otherW})`;
    await sql`DELETE FROM users WHERE id IN (${uid}, ${otherU})`;
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
