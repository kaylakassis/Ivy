// Tests the review lifecycle: reviews AUTO-PUBLISH ('visible') immediately.
// Owners can respond and can APPEAL a review for removal, but cannot hide it
// themselves — only the support team (super-admin) resolves an appeal:
// approve hides the review, deny leaves it visible.
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/reviews-moderation.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import reviewsHandler from '../api/reviews/index.js';
import reviewIdHandler from '../api/reviews/[id].js';
import adminAppealsHandler from '../api/admin/review-appeals.js';

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
  const cookie = `ivy_session=${signSession(uid)}`;

  const publicVisible = async () =>
    (await sql`SELECT COUNT(*)::int n FROM reviews WHERE workspace_id = ${wid} AND status = 'visible'`).rows[0].n;
  const statusOf = async (id) =>
    (await sql`SELECT status FROM reviews WHERE id = ${id}`).rows[0].status;

  console.log('\n[1] a submitted review auto-publishes (visible) immediately');
  const rev = (await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text)
    VALUES (${wid}, 'Casey Client', 2, 'Was just okay') RETURNING id, status`).rows[0];
  assert(rev.status === 'visible', `new review defaults to 'visible' (got '${rev.status}')`);
  assert((await publicVisible()) === 1, 'auto-published review counts in the public set');

  console.log('\n[2] owner can respond to a review');
  let res = mockRes();
  await reviewIdHandler({ method: 'PATCH', headers: hdr(cookie), query: { id: rev.id }, body: { ownerResponse: 'Thanks for the feedback — we hear you!' } }, res);
  assert(res.body?.review?.ownerResponse === 'Thanks for the feedback — we hear you!', 'owner response is saved + returned');

  console.log('\n[3] owner CANNOT hide/publish a review directly');
  res = mockRes();
  await reviewIdHandler({ method: 'PATCH', headers: hdr(cookie), query: { id: rev.id }, body: { status: 'hidden' } }, res);
  assert((await statusOf(rev.id)) === 'visible', "owner's status change is ignored — review stays visible");
  assert((await publicVisible()) === 1, 'review remains public after the owner attempts to hide it');

  console.log('\n[4] owner can appeal a review for removal');
  res = mockRes();
  await reviewIdHandler({ method: 'PATCH', headers: hdr(cookie), query: { id: rev.id }, body: { appealReason: 'This review is fake / defamatory.' } }, res);
  assert(res.body?.review?.appealStatus === 'requested', 'appeal filed (→ requested)');
  assert((await publicVisible()) === 1, 'review stays visible while the appeal is pending');

  console.log('\n[5] owner cannot file a second appeal while one is open');
  res = mockRes();
  await reviewIdHandler({ method: 'PATCH', headers: hdr(cookie), query: { id: rev.id }, body: { appealReason: 'again' } }, res);
  assert(res.statusCode === 400, 'double-appeal is rejected (400)');

  console.log('\n[6] support (super-admin) sees the appeal and can approve → hide');
  await sql`UPDATE users SET user_type = 'super_admin' WHERE id = ${uid}`;
  res = mockRes();
  await adminAppealsHandler({ method: 'GET', headers: hdr(cookie), query: {} }, res);
  assert(res.body?.appeals?.some((a) => a.id === rev.id), 'appeal appears in the super-admin queue');
  res = mockRes();
  await adminAppealsHandler({ method: 'POST', headers: hdr(cookie), query: {}, body: { reviewId: rev.id, action: 'approve' } }, res);
  assert(res.body?.resolved?.status === 'hidden', 'approving the appeal hides the review');
  assert((await publicVisible()) === 0, 'approved-appeal review is removed from public');

  console.log('\n[7] a denied appeal leaves the review visible');
  const rev2 = (await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text)
    VALUES (${wid}, 'Other Client', 1, 'bad') RETURNING id`).rows[0];
  await reviewIdHandler({ method: 'PATCH', headers: hdr(cookie), query: { id: rev2.id }, body: { appealReason: 'please remove' } }, mockRes());
  res = mockRes();
  await adminAppealsHandler({ method: 'POST', headers: hdr(cookie), query: {}, body: { reviewId: rev2.id, action: 'deny' } }, res);
  assert(res.body?.resolved?.appeal_status === 'denied', 'denying resolves the appeal as denied');
  assert((await statusOf(rev2.id)) === 'visible', 'denied-appeal review stays visible');

  console.log('\n[8] owner reviews list still loads (sanity)');
  res = mockRes();
  await reviewsHandler({ method: 'GET', headers: hdr(cookie), query: {} }, res);
  assert(Array.isArray(res.body?.reviews), 'GET /api/reviews returns the owner list');

  // Cleanup.
  await sql`DELETE FROM reviews WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
