// Website form submission with no explicit destination emails the
// workspace OWNER (workspaces.owner_id → users.email). The old query joined
// memberships.user_id, a column that does not exist, so every such
// submission was stored with a delivery error and the lead never arrived.
// Run: node --import ./tests/bootstrap.mjs ./tests/form-submission-owner.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import formSubmission from '../api/website/form-submission.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

// Capture every outbound Resend call instead of hitting the network.
const sent = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('resend.com')) {
    try { sent.push(JSON.parse(init.body)); } catch { /* ignore */ }
  }
  return { ok: true, status: 200, json: async () => ({ id: 'mock' }), text: async () => '{}' };
};

const mockRes = () => ({ statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } });
let ipN = 0;
const req = (body) => ({ method: 'POST', url: '/api/website/form-submission', query: {}, body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', host: 'localhost:3000', 'x-forwarded-for': `198.51.100.${(ipN++ % 200) + 20}` } });

async function main() {
  await ensureSchemaApplied();
  const ownerEmail = `form-owner-${S}@example.com`;
  const owner = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${ownerEmail}, 'x', 'Owner', NOW()) RETURNING id`).rows[0];
  const ws = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end) VALUES (${owner.id}, 'Glow', 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0];
  const handle = `glow-${S}`;
  const site = (await sql`INSERT INTO websites (workspace_id, handle, business_name, published_at) VALUES (${ws.id}, ${handle}, 'Glow Studio', NOW()) RETURNING id`).rows[0];

  console.log('\n[1] no destination configured → the owner gets the email');
  let res = mockRes();
  await formSubmission(req({ handle, formId: 'contact', payload: { name: 'Lead Person', email: `lead-${S}@example.com`, message: 'Hi there' } }), res);
  assert(res.statusCode === 200, `200 (${res.statusCode}) ${JSON.stringify(res.body)}`);
  assert(res.body?.delivered === true, 'response says delivered');
  const row = (await sql`SELECT delivered, delivery_err FROM website_form_submissions WHERE website_id = ${site.id} ORDER BY submitted_at DESC LIMIT 1`).rows[0];
  assert(row && row.delivered === true && row.delivery_err == null, `stored row: delivered=${row?.delivered} err=${row?.delivery_err}`);
  const toOwner = sent.find((m) => (m.to || []).includes(ownerEmail));
  assert(!!toOwner, 'an email went to the workspace owner');
  assert(toOwner && /New contact submission/.test(toOwner.subject), `subject: ${toOwner?.subject}`);
  assert(toOwner && /Lead Person/.test(toOwner.html) && /Hi there/.test(toOwner.html), 'the submitted fields are in the email');

  console.log('\n[2] a deleted owner is not emailed; the row records why');
  await sql`UPDATE users SET deleted_at = NOW() WHERE id = ${owner.id}`;
  sent.length = 0;
  res = mockRes();
  await formSubmission(req({ handle, formId: 'newsletter', payload: { email: `sub-${S}@example.com` } }), res);
  assert(res.statusCode === 200 && res.body?.delivered === false, `200 but not delivered (${res.statusCode}, delivered=${res.body?.delivered})`);
  const row2 = (await sql`SELECT delivered, delivery_err FROM website_form_submissions WHERE website_id = ${site.id} AND form_id = 'newsletter' ORDER BY submitted_at DESC LIMIT 1`).rows[0];
  assert(row2 && row2.delivered === false && /no workspace owner email/i.test(row2.delivery_err || ''), `row says: ${row2?.delivery_err}`);
  assert(!sent.some((m) => (m.to || []).includes(ownerEmail)), 'nothing sent to the deleted owner');

  // A second, live business for the archive + auto-reply cap checks.
  const owner2Email = `form-owner2-${S}@example.com`;
  const owner2 = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${owner2Email}, 'x', 'Owner Two', NOW()) RETURNING id`).rows[0];
  const ws2 = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end) VALUES (${owner2.id}, 'Bloom', 'active', NOW() + INTERVAL '30 days') RETURNING id`).rows[0];
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, lead_instant_reply_enabled) VALUES (${ws2.id}, 'Bloom Studio', ${`bloom-${S}`}, TRUE)
            ON CONFLICT (workspace_id) DO UPDATE SET lead_instant_reply_enabled = TRUE`;
  const handle2 = `bloom-${S}`;
  const site2 = (await sql`INSERT INTO websites (workspace_id, handle, business_name, published_at) VALUES (${ws2.id}, ${handle2}, 'Bloom Studio', NOW()) RETURNING id`).rows[0];
  const toLead = (addr) => sent.filter((m) => (m.to || []).includes(addr) && /Thanks for reaching out/.test(m.subject || ''));
  const toOwner2 = () => sent.filter((m) => (m.to || []).includes(owner2Email));

  console.log('\n[3] auto-reply caps: max 2 per person per day; lead + owner email still happen');
  sent.length = 0;
  const repeat = `repeat-${S}@example.com`;
  for (let i = 0; i < 3; i++) {
    res = mockRes();
    await formSubmission(req({ handle: handle2, formId: 'contact', payload: { name: 'Rhea Repeat', email: repeat, message: `try ${i}` } }), res);
    assert(res.statusCode === 200, `submission ${i + 1} accepted (${res.statusCode})`);
  }
  assert(toLead(repeat).length === 2, `only 2 auto-replies to the same person (got ${toLead(repeat).length})`);
  assert(toOwner2().length === 3, `owner told about all 3 (got ${toOwner2().length})`);
  const subs = (await sql`SELECT COUNT(*)::int n FROM website_form_submissions WHERE website_id = ${site2.id}`).rows[0].n;
  assert(subs === 3, 'all 3 submissions stored');
  assert((await sql`SELECT COUNT(*)::int n FROM clients WHERE workspace_id = ${ws2.id} AND lower(email) = ${repeat}`).rows[0].n === 1, 'lead recorded in the CRM');

  console.log('\n[3b] business cap: 50 auto-replies per day, then none (owner still told)');
  await sql.query(`INSERT INTO rate_limits (key, attempted_at) SELECT $1, NOW() FROM generate_series(1, 48)`, [`lead-autoreply:ws:${ws2.id}`]);
  sent.length = 0;
  const late = `late-${S}@example.com`;
  res = mockRes();
  await formSubmission(req({ handle: handle2, formId: 'contact', payload: { name: 'Lou Late', email: late, message: 'hello' } }), res);
  assert(res.statusCode === 200 && toLead(late).length === 0, 'over the business cap: no auto-reply');
  assert(toOwner2().length === 1, 'owner still emailed');
  assert((await sql`SELECT COUNT(*)::int n FROM clients WHERE workspace_id = ${ws2.id} AND lower(email) = ${late}`).rows[0].n === 1, 'lead still recorded');

  console.log('\n[4] lapsed subscription: the website form is closed, like the booking-page form');
  await sql`UPDATE workspaces SET subscription_status = 'cancelled', subscription_period_end = NOW() - INTERVAL '1 day' WHERE id = ${ws2.id}`;
  sent.length = 0;
  const before = (await sql`SELECT COUNT(*)::int n FROM website_form_submissions WHERE website_id = ${site2.id}`).rows[0].n;
  res = mockRes();
  await formSubmission(req({ handle: handle2, formId: 'contact', payload: { name: 'Ann After', email: `after-${S}@example.com`, message: 'hi' } }), res);
  assert(res.statusCode === 403 && res.body?.code === 'business_archived', `403 business_archived (${res.statusCode} ${JSON.stringify(res.body)})`);
  assert((await sql`SELECT COUNT(*)::int n FROM website_form_submissions WHERE website_id = ${site2.id}`).rows[0].n === before, 'nothing stored');
  assert(sent.length === 0, 'no emails sent');
  assert((await sql`SELECT COUNT(*)::int n FROM clients WHERE workspace_id = ${ws2.id} AND lower(email) = ${`after-${S}@example.com`}`).rows[0].n === 0, 'no lead created');

  await sql`DELETE FROM rate_limits WHERE key LIKE ${`lead-autoreply:ws:${ws2.id}%`}`;
  await sql`DELETE FROM workspaces WHERE id IN (${ws.id}, ${ws2.id})`;
  await sql`DELETE FROM users WHERE id IN (${owner.id}, ${owner2.id})`;

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
