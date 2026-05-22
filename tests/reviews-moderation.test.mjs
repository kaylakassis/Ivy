// Tests review moderation: submitted reviews are held 'pending' (NOT
// public) until the owner publishes them from the Reviews tab. Previously
// reviews inserted as 'visible' and went public instantly — a 1-star
// review with no owner recourse, contradicting the request email.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/reviews-moderation.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import reviewsHandler from '../api/reviews/index.js';
import reviewIdHandler from '../api/reviews/[id].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    setHeader() {}, getHeader() {}, end() { return this; },
  };
}
const hdr = (cookie, extra = {}) => ({ cookie, origin: 'http://localhost:3000', host: 'localhost:3000', ...extra });

async function run() {
  await ensureSchemaApplied();

  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`rev-mod-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  const cookie = `thryve_session=${signSession(uid)}`;

  const publicVisible = async () =>
    (await sql`SELECT COUNT(*)::int n FROM reviews WHERE workspace_id = ${wid} AND status = 'visible'`).rows[0].n;

  console.log('\n[1] a submitted review defaults to pending (not public)');
  // No status specified → column default. Verifies the DEFAULT migration applied.
  const revId = (await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text)
    VALUES (${wid}, 'Casey Client', 2, 'Was just okay') RETURNING id, status`).rows[0];
  assert(revId.status === 'pending', `new review status defaults to 'pending' (got '${revId.status}')`);
  assert((await publicVisible()) === 0, 'pending review is NOT counted in the public (visible) set');

  console.log('\n[2] owner sees it in the moderation list with a pending count');
  let res = mockRes();
  await reviewsHandler({ method: 'GET', headers: hdr(cookie), query: {} }, res);
  assert(res.body?.summary?.pendingCount === 1, 'summary.pendingCount = 1');
  assert(res.body?.summary?.visibleCount === 0, 'summary.visibleCount = 0');
  assert(res.body?.reviews?.some((r) => r.id === revId.id && r.status === 'pending'), 'review appears in the owner list as pending');

  console.log('\n[3] publishing it makes it public');
  res = mockRes();
  await reviewIdHandler({ method: 'PATCH', headers: hdr(cookie), query: { id: revId.id }, body: { status: 'visible' } }, res);
  assert(res.body?.review?.status === 'visible', 'PATCH status=visible publishes the review');
  assert((await publicVisible()) === 1, 'published review now counts in the public set');

  res = mockRes();
  await reviewsHandler({ method: 'GET', headers: hdr(cookie), query: {} }, res);
  assert(res.body?.summary?.pendingCount === 0 && res.body?.summary?.visibleCount === 1, 'summary reflects publish (pending 0, visible 1)');

  console.log('\n[4] hiding a review pulls it back out of public');
  res = mockRes();
  await reviewIdHandler({ method: 'PATCH', headers: hdr(cookie), query: { id: revId.id }, body: { status: 'hidden' } }, res);
  assert(res.body?.review?.status === 'hidden', 'PATCH status=hidden hides it');
  assert((await publicVisible()) === 0, 'hidden review is not public');

  // Cleanup.
  await sql`DELETE FROM reviews WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
