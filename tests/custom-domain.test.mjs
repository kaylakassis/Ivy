// Custom-domain lifecycle for the website builder.
//   • The Vercel helper (api/_lib/vercelDomains.js) no-ops cleanly when
//     VERCEL_TOKEN / VERCEL_PROJECT_ID aren't set (so DNS verify still
//     works without credentials and tests never hit the network).
//   • Changing the custom_domain via the website PUT resets domain_status
//     so the new domain must be re-verified; an UNCHANGED domain keeps
//     its verified status; clearing the domain nulls custom_domain.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/custom-domain.test.mjs

import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { addProjectDomain, removeProjectDomain, getDomainConfig } from '../api/_lib/vercelDomains.js';
import websiteHandler from '../api/website/index.js';

// Guarantee the helper is in its unconfigured state for this run.
delete process.env.VERCEL_TOKEN;
delete process.env.VERCEL_PROJECT_ID;
delete process.env.VERCEL_TEAM_ID;

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; }, setHeader() {} };
}

const createdUsers = [];
async function run() {
  try {
    console.log('\n[1] Vercel helper no-ops without credentials');
    assert((await addProjectDomain('rivers.com')).configured === false, 'addProjectDomain -> configured:false');
    assert((await removeProjectDomain('rivers.com')).configured === false, 'removeProjectDomain -> configured:false');
    const cfg = await getDomainConfig('rivers.com');
    assert(cfg.configured === false && cfg.live === null, 'getDomainConfig -> configured:false, live:null');

    // Owner + workspace + a website with an already-verified custom domain.
    const u = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`cd-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
    createdUsers.push(u.rows[0].id);
    const uid = u.rows[0].id;
    const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    const handle = `cd${Date.now()}`;
    await sql`INSERT INTO websites (workspace_id, handle, business_name, template, sections, pages, visibility, custom_domain, domain_status)
      VALUES (${wid}, ${handle}, 'Biz', 'clean', '[]'::jsonb, '[]'::jsonb, 'public', 'rivers.com', 'verified')`;

    const cookie = `ivy_session=${signSession(uid)}`;
    const put = (body) => ({ method: 'PUT', headers: { cookie }, url: '/api/website', query: {}, body });
    const statusOf = async () =>
      (await sql`SELECT custom_domain, domain_status FROM websites WHERE workspace_id = ${wid}`).rows[0];

    console.log('\n[2] PUT with the SAME domain keeps verified status');
    let r = mockRes(); await websiteHandler(put({ customDomain: 'rivers.com' }), r);
    assert(r.statusCode === 200, 'PUT same domain -> 200');
    assert((await statusOf()).domain_status === 'verified', 'unchanged domain keeps domain_status = verified');

    console.log('\n[3] PUT with a DIFFERENT domain resets status (forces re-verify)');
    r = mockRes(); await websiteHandler(put({ customDomain: 'lakes.com' }), r);
    let s = await statusOf();
    assert(s.custom_domain === 'lakes.com', 'custom_domain updated to lakes.com');
    assert(s.domain_status === null, 'changed domain resets domain_status to NULL');

    console.log('\n[4] Clearing the domain nulls custom_domain');
    r = mockRes(); await websiteHandler(put({ customDomain: '' }), r);
    s = await statusOf();
    assert(s.custom_domain === null, 'clearing sets custom_domain = NULL');
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
