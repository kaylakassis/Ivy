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

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
