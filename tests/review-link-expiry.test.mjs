// "Leave a review" links expire 60 days after they were sent
// (api/review/[token].js). Links already sent follow the same rule.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/review-link-expiry.test.mjs
import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import reviewHandler from '../api/review/[token].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
  };
}
let ipN = 0;
function req({ method = 'GET', token, body } = {}) {
  ipN++;
  return { method, url: `/api/review/${token}`, query: { token }, body,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${(ipN % 200) + 30}` } };
}
const TAG = `rlx-${Date.now()}`;
const DAY = 864e5;
let ownerId;

async function run() {
  try {
    await ensureSchemaApplied();
    ownerId = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${`${TAG}@example.com`}, 'x', 'Owner') RETURNING id`).rows[0].id;
    const wid = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end)
      VALUES (${ownerId}, 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0].id;
    await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug) VALUES (${wid}, 'Expiry Studio', ${TAG})`;
    const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Rae', ${`${TAG}-c@example.com`}, 'active') RETURNING id`).rows[0].id;

    async function mk({ sentDaysAgo, createdDaysAgo = 90 }) {
      const raw = crypto.randomBytes(24).toString('base64url');
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      const sentAt = sentDaysAgo == null ? null : new Date(Date.now() - sentDaysAgo * DAY).toISOString();
      const id = (await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min,
          review_request_token_hash, review_requested_at, created_at)
        VALUES (${wid}, ${cid}, 'Rae', ${`${TAG}-c@example.com`}, ${new Date(Date.now() - 95 * DAY).toISOString().slice(0, 10)}, 600, 660,
          ${hash}, ${sentAt}, ${new Date(Date.now() - createdDaysAgo * DAY).toISOString()}) RETURNING id`).rows[0].id;
      return { raw, id };
    }
    const reviewsFor = async (bookingId) => (await sql`SELECT COUNT(*)::int n FROM reviews WHERE booking_id = ${bookingId}`).rows[0].n;

    console.log('\n[1] sent 59 days ago: still works');
    const fresh = await mk({ sentDaysAgo: 59 });
    let r = mockRes();
    await reviewHandler(req({ token: fresh.raw }), r);
    assert(r.statusCode === 200 && r.body?.booking?.businessName === 'Expiry Studio', `GET 200 (got ${r.statusCode})`);
    r = mockRes();
    await reviewHandler(req({ method: 'POST', token: fresh.raw, body: { rating: 5 } }), r);
    assert(r.statusCode === 200 && await reviewsFor(fresh.id) === 1, 'review accepted');

    console.log('\n[2] sent 61 days ago: friendly expired answer, no review');
    const old = await mk({ sentDaysAgo: 61 });
    r = mockRes();
    await reviewHandler(req({ token: old.raw }), r);
    assert(r.statusCode === 410, `GET 410 (got ${r.statusCode})`);
    assert(r.body?.error === 'This review link has expired. Thanks for thinking of us.', 'plain-language expired message');
    assert(r.body?.code === 'review_link_expired', 'code lets the page show the expired card');
    assert(!/[\u2013\u2014]/.test(r.body?.error || ''), 'no dashes in the copy');
    assert(!r.body?.booking, 'no booking details leak from an expired link');
    r = mockRes();
    await reviewHandler(req({ method: 'POST', token: old.raw, body: { rating: 1, text: 'late' } }), r);
    assert(r.statusCode === 410 && await reviewsFor(old.id) === 0, 'POST refused: no review stored');

    console.log('\n[3] older link with no send date: 60 days from the booking row');
    const legacy = await mk({ sentDaysAgo: null, createdDaysAgo: 70 });
    r = mockRes();
    await reviewHandler(req({ token: legacy.raw }), r);
    assert(r.statusCode === 410, `legacy link past 60 days expires (got ${r.statusCode})`);
    const legacyFresh = await mk({ sentDaysAgo: null, createdDaysAgo: 10 });
    r = mockRes();
    await reviewHandler(req({ token: legacyFresh.raw }), r);
    assert(r.statusCode === 200, 'legacy link within 60 days still works');

    console.log('\n[4] unknown token is still a plain 404');
    r = mockRes();
    await reviewHandler(req({ token: 'x'.repeat(32) }), r);
    assert(r.statusCode === 404, 'unknown token 404');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    if (ownerId) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${ownerId}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
