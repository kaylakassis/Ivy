// Admin "Revenue in Ivy" per business + the Privacy Policy update flow.
//   • workspace_revenue counts only money that changed hands through Ivy,
//     net of refunds, never double-counting gift-card-paid invoices, and
//     ignores drafts, sample data, manual package grants and owner-issued
//     gift cards.
//   • /api/admin/users returns it (operator only) and can sort by it.
//   • Sign-up still accepts the previous policy version (the iPhone build in
//     the App Store) and records exactly the version accepted.
//   • /api/auth/me flags the update; acknowledging it records the version.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/admin-revenue-privacy.test.mjs
process.env.ADMIN_SECRET ||= 'test-admin-secret';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION, PRIOR_PRIVACY_VERSIONS } from '../api/_lib/legal.js';
import usersList from '../api/admin/users.js';
import signupHandler from '../api/auth/signup.js';
import meHandler from '../api/auth/me.js';
import acceptTerms from '../api/me/accept-terms.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const mockRes = () => ({
  statusCode: 200, headers: {}, body: null,
  status(c) { this.statusCode = c; return this; },
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
  json(o) { this.body = o; return this; }, end() { return this; },
});
let ipN = 0;
const req = ({ method = 'GET', body = {}, query = {}, headers = {} } = {}) => ({
  method, url: '/test', query, body,
  headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': `203.0.113.${(ipN++ % 200) + 20}`, ...headers },
});
const call = async (h, o) => { const r = mockRes(); await h(req(o), r); return r; };
const S = Date.now();
const userIds = [];

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] workspace_revenue counts only real money, once');
    const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`rev-${S}@example.com`}, 'x', 'Rev Owner', NOW()) RETURNING id`).rows[0].id;
    userIds.push(u);
    const w = (await sql`INSERT INTO workspaces (owner_id, subscription_status) VALUES (${u}, 'active') RETURNING id`).rows[0].id;
    const c = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${w}, 'Pat', ${`pat-${S}@example.com`}, 'active') RETURNING id`).rows[0].id;
    // Paid invoice $200 with $20 refunded and $30 paid by gift card → $150.
    // invoices.total is computed from items by a trigger.
    await sql`INSERT INTO invoices (workspace_id, number, client_id, items, status, refunded_amount, gift_card_credit_cents, paid_at)
      VALUES (${w}, ${`R-${S}-1`}, ${c}, ${JSON.stringify([{ description: 'Session', quantity: 2, rate: 100 }])}::jsonb, 'paid', 20, 3000, NOW())`;
    // Draft + sample invoices never count.
    await sql`INSERT INTO invoices (workspace_id, number, client_id, items, status, total, notes)
      VALUES (${w}, ${`R-${S}-2`}, ${c}, ${JSON.stringify([{ description: 'Sample service', quantity: 1, rate: 999 }])}::jsonb, 'draft', 999, '[Sample] Example invoice')`;
    // Paid store order $40; pending order ignored.
    await sql`INSERT INTO orders (workspace_id, customer_name, customer_email, total, status, paid_at) VALUES (${w}, 'Pat', 'pat@example.com', 40, 'paid', NOW())`;
    await sql`INSERT INTO orders (workspace_id, customer_name, customer_email, total, status) VALUES (${w}, 'Pat', 'pat@example.com', 500, 'pending')`;
    // One-time program purchase $99 with $9 refunded → $90; a manual grant ignored.
    const prog = (await sql`INSERT INTO programs (workspace_id, title, price_cents) VALUES (${w}, 'Course', 9900) RETURNING id`).rows[0].id;
    await sql`INSERT INTO program_enrollments (program_id, workspace_id, client_id, source, price_cents, refunded_cents) VALUES (${prog}, ${w}, ${c}, 'purchase', 9900, 900)`;
    const c2 = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${w}, 'Lee', ${`lee-${S}@example.com`}, 'active') RETURNING id`).rows[0].id;
    await sql`INSERT INTO program_enrollments (program_id, workspace_id, client_id, source, price_cents) VALUES (${prog}, ${w}, ${c2}, 'manual', 9900)`;
    // Package bought online $120; a manual package grant ignored.
    await sql`INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining, price, stripe_payment_intent) VALUES (${w}, ${c}, 'Five pack', 5, 5, 120, ${`pi_${S}_pkg`})`;
    await sql`INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining, price) VALUES (${w}, ${c}, 'Comped pack', 5, 5, 300)`;
    // Gift card sold online $50; owner-issued card ignored.
    await sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, stripe_payment_intent) VALUES (${w}, ${`h1-${S}`}, 'AAAA', 5000, 5000, ${`pi_${S}_gc`})`;
    await sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents) VALUES (${w}, ${`h2-${S}`}, 'BBBB', 7000, 7000)`;
    // Booking: deposit $25 paid, tip $10 charged, fee $15 charged; an unpaid deposit ignored.
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, deposit_paid, deposit_paid_at, tip_amount, tip_charged_at, fee_charged_amount, fee_charged_at)
      VALUES (${w}, ${c}, 'Pat', 'pat@example.com', CURRENT_DATE, 600, 660, 25, NOW(), 10, NOW(), 15, NOW())`;
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min, deposit_paid)
      VALUES (${w}, ${c}, 'Pat', 'pat@example.com', CURRENT_DATE, 700, 760, 80)`;
    const rev = (await sql`SELECT * FROM workspace_revenue WHERE workspace_id = ${w}`).rows[0];
    assert(Number(rev.invoices) === 150, `invoices net of refund and gift card credit (${rev.invoices})`);
    assert(Number(rev.store_orders) === 40, `paid store orders only (${rev.store_orders})`);
    assert(Number(rev.programs) === 90, `one-time program purchases net of refund (${rev.programs})`);
    assert(Number(rev.packages) === 120, `packages bought online only (${rev.packages})`);
    assert(Number(rev.gift_cards) === 50, `gift cards sold online only (${rev.gift_cards})`);
    assert(Number(rev.booking_payments) === 50, `deposits, tips and fees actually charged (${rev.booking_payments})`);
    assert(Number(rev.total) === 500, `total ${rev.total} = 500`);

    console.log('\n[2] admin users list: operator only, carries revenue, sorts by it');
    const adminH = { 'x-admin-secret': process.env.ADMIN_SECRET };
    let r = await call(usersList, { query: { q: `rev-${S}` }, headers: adminH });
    const row = r.body?.users?.find((x) => x.id === u);
    assert(r.statusCode === 200 && row?.revenue?.total === 500 && row.revenue.invoices === 150 && row.revenue.bookingPayments === 50, 'list returns the breakdown');
    r = await call(usersList, { query: { sort: 'revenue' }, headers: adminH });
    const totals = (r.body?.users || []).map((x) => x.revenue?.total || 0);
    assert(r.statusCode === 200 && totals.every((v, i) => i === 0 || totals[i - 1] >= v), 'sort=revenue orders highest first');
    r = await call(usersList, { query: { sort: "revenue; DROP TABLE users" }, headers: adminH });
    assert(r.statusCode === 200, 'an unknown sort value falls back safely');
    r = await call(usersList, { headers: { cookie: `ivy_session=${signSession(u)}` } });
    assert(r.statusCode === 403 || r.statusCode === 401, `a normal owner cannot read the admin list (${r.statusCode})`);

    console.log('\n[3] sign-up accepts the previous policy version and records it exactly');
    assert(PRIOR_PRIVACY_VERSIONS.length > 0 && !PRIOR_PRIVACY_VERSIONS.includes(CURRENT_PRIVACY_VERSION), 'a prior version is listed');
    const oldEmail = `oldapp-${S}@example.com`;
    r = await call(signupHandler, { method: 'POST', body: { email: oldEmail, password: 'a-good-password-123', name: 'Old App', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: PRIOR_PRIVACY_VERSIONS[0] } });
    assert(r.statusCode === 200 || r.statusCode === 201, `sign-up from the App Store build succeeds (${r.statusCode})`);
    const oldU = (await sql`SELECT id, privacy_version FROM users WHERE email = ${oldEmail}`).rows[0];
    if (oldU) userIds.push(oldU.id);
    assert(oldU?.privacy_version === PRIOR_PRIVACY_VERSIONS[0], 'records the version actually accepted');
    const audit = (await sql`SELECT version FROM legal_acceptances WHERE user_id = ${oldU?.id} AND document = 'privacy'`).rows;
    assert(audit.length === 1 && audit[0].version === PRIOR_PRIVACY_VERSIONS[0], 'audit row matches');
    r = await call(signupHandler, { method: 'POST', body: { email: `bad-${S}@example.com`, password: 'a-good-password-123', name: 'Bad', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: '1999-01-01' } });
    assert(r.statusCode === 400, 'an unknown version is refused');

    console.log('\n[4] /api/auth/me flags the update; acknowledging records it');
    const cookie = `ivy_session=${signSession(oldU.id)}`;
    r = await call(meHandler, { headers: { cookie } });
    assert(r.body?.privacy?.needsAcknowledgement === true && r.body?.privacy?.currentVersion === CURRENT_PRIVACY_VERSION, 'needsAcknowledgement true for the older version');
    assert(r.body?.terms?.needsAcceptance === false, 'terms gate unaffected');
    r = await call(acceptTerms, { method: 'POST', headers: { cookie }, body: { document: 'privacy', version: '2000-01-01' } });
    assert(r.statusCode === 400, 'wrong version refused');
    r = await call(acceptTerms, { method: 'POST', headers: { cookie }, body: { document: 'privacy', version: CURRENT_PRIVACY_VERSION } });
    assert(r.statusCode === 200, 'acknowledgement saved');
    r = await call(meHandler, { headers: { cookie } });
    assert(r.body?.privacy?.needsAcknowledgement === false, 'notice no longer pending');
    const audit2 = (await sql`SELECT version FROM legal_acceptances WHERE user_id = ${oldU.id} AND document = 'privacy' ORDER BY accepted_at`).rows.map((x) => x.version);
    assert(audit2.includes(CURRENT_PRIVACY_VERSION), 'audit trail has the new version');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    try {
      for (const id of userIds) {
        await sql`DELETE FROM workspaces WHERE owner_id = ${id}`;
        await sql`DELETE FROM users WHERE id = ${id}`;
      }
    } catch (e) { console.error('cleanup:', e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
