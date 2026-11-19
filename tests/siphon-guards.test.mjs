// "Ivy hands out no more than it needs to": the fixes from the scraping
// review, each pinned so it cannot quietly come back.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/siphon-guards.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { serializeReview } from '../api/_lib/reviews.js';
import { publicSettings, publicService, serializeSettings, serializeService } from '../api/_lib/calendar.js';
import { toolErrorText } from '../api/_lib/ivyTools.js';
import { buildAccountExport } from '../api/_lib/accountExport.js';
import { _resetForTests as resetWatch } from '../api/_lib/activityWatch.js';
import bookingPage from '../api/calendar/public/[slug].js';
import clientsHandler from '../api/clients/index.js';
import clientHandler from '../api/clients/[id].js';
import exportHandler from '../api/account/export.js';
import readyHandler from '../api/health/ready.js';
import giftCheck from '../api/gift-cards/check.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST = 'localhost:3000';
const users = [];
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function mkRes() {
  const chunks = [];
  return { statusCode: 200, headers: {}, body: null, chunks,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; },
    write(s) { chunks.push(String(s)); return true; }, end(s) { if (s !== undefined) chunks.push(String(s)); if (this.body == null && chunks.length) this.body = chunks.join(''); return this; } };
}
let ipN = 10;
async function call(handler, { method = 'GET', userId, query = {}, body, headers = {}, url = '/api/x' } = {}) {
  const req = { method, url, query, body, headers: { host: HOST, origin: `http://${HOST}`, 'x-real-ip': `198.51.100.${ipN}`, 'content-type': 'application/json', ...(userId ? { cookie: `ivy_session=${signSession(userId)}` } : {}), ...headers } };
  const res = mkRes(); res.req = req;
  await handler(req, res);
  return res;
}
async function mkBusiness(tag, { status = 'active', periodDays = 30, trial = null, slug = null } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, signup_role)
    VALUES (${`siphon-${tag}-${S}@example.com`}, 'x', ${`Owner ${tag}`}, NOW(), 'owner') RETURNING id, email, name`).rows[0];
  users.push(u.id);
  const ws = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, trial_ends_at, onboarded_at)
    VALUES (${u.id}, ${status}, ${periodDays == null ? null : new Date(Date.now() + periodDays * 86400e3).toISOString()}, ${trial}, NOW()) RETURNING id`).rows[0].id;
  const sl = slug || `siphon-${tag}-${S}`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, lat, lng, lead_instant_reply_message)
    VALUES (${ws}, ${`Biz ${tag}`}, ${sl}, 33.553912, -117.213921, 'Thanks, I will call you tonight') ON CONFLICT (workspace_id) DO UPDATE SET biz_name = EXCLUDED.biz_name, slug = EXCLUDED.slug, lat = EXCLUDED.lat, lng = EXCLUDED.lng, lead_instant_reply_message = EXCLUDED.lead_instant_reply_message`;
  return { user: u, ws, slug: sl };
}

async function main() {
  await ensureSchemaApplied();
  resetWatch();

  console.log('\n[1] a review appeal is between the owner and Ivy');
  const reviewRow = { id: 'r1', rating: 2, text: 'meh', reviewer_name: 'Sam', status: 'visible', appeal_status: 'requested', appeal_reason: 'This person was never my client', appeal_requested_at: new Date(), created_at: new Date() };
  const pub = serializeReview(reviewRow);
  const own = serializeReview(reviewRow, { includeHidden: true });
  assert(!('appealReason' in pub) && !('appealStatus' in pub) && !('appealRequestedAt' in pub) && !JSON.stringify(pub).includes('never my client'), 'the public page gets no appeal fields');
  assert(own.appealReason === 'This person was never my client' && own.appealStatus === 'requested', 'the owner still sees their own appeal');

  console.log('\n[2] the public booking page');
  const A = await mkBusiness('a');
  await sql`INSERT INTO calendar_blocks (workspace_id, date, start_min, end_min, label, blocks_bookings) VALUES
    (${A.ws}, CURRENT_DATE - 400, 540, 600, 'Surgery', TRUE), (${A.ws}, CURRENT_DATE + 3, 540, 600, 'Dentist', TRUE)`;
  await sql`INSERT INTO services (workspace_id, name, duration_minutes, price, reminder_minutes, prep_instructions)
    VALUES (${A.ws}, 'Cut', 60, 80, ARRAY[1440, 60], 'Arrive with dry hair')`;
  ipN++;
  let r = await call(bookingPage, { query: { slug: A.slug }, url: `/api/calendar/public/${A.slug}` });
  const cal = r.body?.calendar;
  assert(r.statusCode === 200 && cal?.services?.length === 1, `the page loads (${r.statusCode})`);
  assert(cal.blocks.length === 1 && cal.blocks[0].label === 'Busy', 'only upcoming blocked time is sent, labelled "Busy" (time off from last year is not)');
  assert(cal.settings.lat === null && cal.settings.lng === null && cal.settings.leadInstantReplyMessage === '' && cal.settings.bizName === 'Biz a' && cal.settings.availability !== undefined,
    'settings: no exact map point, no private auto-reply text; name and hours still there');
  assert(cal.services[0].prepInstructions === 'Arrive with dry hair' && cal.services[0].reminderMinutes.length === 0 && cal.services[0].intakeFormTemplateIds.length === 0 && cal.services[0].price === 80,
    'services: price and prep notes for the visitor, not the owner\'s reminder timings');
  const full = serializeSettings({ biz_name: 'x', lat: 1.5, lng: 2.5, lead_instant_reply_message: 'hi' });
  assert(full.lat === 1.5 && full.leadInstantReplyMessage === 'hi' && publicSettings({ biz_name: 'x', lat: 1.5 }).lat === null
    && serializeService({ id: 1, name: 's', reminder_minutes: [30] }).reminderMinutes[0] === 30 && publicService({ id: 1, name: 's', reminder_minutes: [30] }).reminderMinutes.length === 0,
    'the owner\'s own screens keep every field');

  console.log('\n[3] an account that never started has no public address');
  const never = await mkBusiness('never', { status: 'trialing', periodDays: null });
  const lapsed = await mkBusiness('lapsed', { status: 'canceled', periodDays: -10 });
  ipN++;
  r = await call(bookingPage, { query: { slug: never.slug }, url: `/api/calendar/public/${never.slug}` });
  const neverBody = JSON.stringify(r.body);
  ipN++;
  const r404 = await call(bookingPage, { query: { slug: `nobody-${S}` }, url: `/api/calendar/public/nobody-${S}` });
  assert(r.statusCode === 404 && !/Biz never/.test(neverBody) && neverBody === JSON.stringify(r404.body), 'signed up, never started: the same "not found" as a name nobody has');
  ipN++;
  r = await call(bookingPage, { query: { slug: lapsed.slug }, url: `/api/calendar/public/${lapsed.slug}` });
  assert(r.statusCode === 200 && r.body.archived === true && r.body.businessName === 'Biz lapsed', 'a business that was live and stopped still shows its "no longer available" card to its clients');

  console.log('\n[4] helpers never see money through the client list');
  const cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage, lifetime_value) VALUES (${A.ws}, 'Big Spender', ${`big-${S}@example.com`}, 'active', 4321.5) RETURNING id`).rows[0].id;
  const h = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${`siphon-h-${S}@example.com`}, 'x', 'Helper', NOW()) RETURNING id`).rows[0];
  users.push(h.id);
  await sql`INSERT INTO staff_members (workspace_id, name, email, active, owner_managed, user_id, permissions)
    VALUES (${A.ws}, 'Helper', ${`siphon-hs-${S}@example.com`}, TRUE, TRUE, ${h.id}, ${JSON.stringify({ clients: true })}::jsonb)`;
  const asA = { 'x-helper-workspace': A.ws };
  r = await call(clientsHandler, { userId: h.id, headers: asA, url: '/api/clients?h=1' });
  let seen = (r.body?.clients || []).find((c) => c.id === cid);
  assert(r.statusCode === 200 && seen && seen.lifetimeValue === 0 && seen.name === 'Big Spender', 'helper with the clients permission: sees the client, not what they have spent');
  r = await call(clientHandler, { userId: h.id, headers: asA, query: { id: cid }, url: `/api/clients/${cid}` });
  assert(r.statusCode === 200 && r.body.client.lifetimeValue === 0, 'same on the single client');
  r = await call(clientHandler, { method: 'PATCH', userId: h.id, headers: asA, query: { id: cid }, body: { lifetimeValue: 1, notes: 'helper note' }, url: `/api/clients/${cid}` });
  const after = (await sql`SELECT lifetime_value, notes FROM clients WHERE id = ${cid}`).rows[0];
  assert(Number(after.lifetime_value) === 4321.5 && after.notes === 'helper note', 'a helper can write a note but cannot change the spend figure');
  r = await call(clientsHandler, { userId: A.user.id, url: '/api/clients?o=1' });
  seen = (r.body?.clients || []).find((c) => c.id === cid);
  assert(seen && seen.lifetimeValue === 4321.5, 'the owner still sees it');
  r = await call(clientsHandler, { userId: h.id, headers: asA, query: { limit: '5000' }, url: '/api/clients?limit=5000' });
  assert(/Math\.min\(req\.helper \? 1000 : 5000, requestedLimit\)/.test(read('api/clients/index.js')), 'a helper\'s list request is capped lower than the owner\'s');
  const helpers = read('api/_lib/helpers.js'); const drawer = read('src/features/calendar/StaffDrawer.jsx');
  assert(/look up any client\\'s name, email and phone/.test(helpers) && /look up any client by name, email and phone/.test(drawer) && /They never see money/.test(drawer),
    'the permission wording the owner sees says what each switch really shares');

  console.log('\n[5] the "download my data" file');
  await sql`UPDATE workspaces SET comp_note = 'friend of the founder', risk_hold_reason = 'suspected fraud', billing_checkout_key = 'key_abc' WHERE id = ${A.ws}`;
  await sql`UPDATE clients SET user_id = ${h.id} WHERE id = ${cid}`;
  const exp = await buildAccountExport(A.user);
  const expText = JSON.stringify(exp);
  assert(exp.workspace.id === A.ws && exp.workspace.subscription_status === 'active' && !/friend of the founder|suspected fraud|key_abc/.test(expText)
    && !('comp_note' in exp.workspace) && !('risk_hold_reason' in exp.workspace) && !('billing_checkout_key' in exp.workspace), 'holds the owner\'s business details, none of Ivy\'s own notes about the account');
  assert(exp.clients.some((c) => c.id === cid && c.name === 'Big Spender') && exp.clients.every((c) => !('user_id' in c)) && !expText.includes(h.id), 'clients are all there, without links to other people\'s sign-ins');
  await sql`DELETE FROM rate_limits WHERE key = ${`export-dl:user:${A.user.id}`}`;
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await call(exportHandler, { userId: A.user.id, url: `/api/account/export?n=${i}` })).statusCode);
  assert(codes.slice(0, 6).every((c) => c === 200) && codes.slice(6).every((c) => c === 429), `downloads are capped per hour (${codes.join(',')})`);
  const audits = (await sql`SELECT action, meta FROM audit_events WHERE workspace_id = ${A.ws} AND action = 'data.export'`).rows;
  assert(audits.length === 6 && audits[0].meta.how === 'download', `and every one is written down (${audits.length})`);
  const acct = read('api/finance/accounting-export.js'); const tax = read('api/finance/tax-export.js');
  assert(/finexport:user/.test(acct) && /finance\.export\.accounting/.test(acct) && /finexport:user/.test(tax) && /finance\.export\.tax/.test(tax), 'the two money exports are capped and written down too');

  console.log('\n[6] small doors closed');
  assert(!existsSync(new URL('../api/public-stats.js', import.meta.url)), 'the public "how many users" counter is gone');
  ipN++;
  r = await call(readyHandler, { url: '/api/health/ready' });
  assert((r.statusCode === 200 || r.statusCode === 503) && Object.keys(r.body).sort().join() === 'status,time', `the status check tells a stranger "ok" and nothing about set-up (${Object.keys(r.body || {}).join(',')})`);
  ipN++;
  const g1 = await call(giftCheck, { method: 'POST', body: { slug: `nobody-${S}`, code: 'ABCD-EFGH-JKLM' }, url: '/api/gift-cards/check' });
  ipN++;
  const g2 = await call(giftCheck, { method: 'POST', body: { slug: A.slug, code: 'ABCD-EFGH-JKLM' }, url: '/api/gift-cards/check' });
  assert(g1.statusCode === 404 && g2.statusCode === 404 && JSON.stringify(g1.body) === JSON.stringify(g2.body), 'a gift card check answers the same for an unknown business and an unknown card');
  assert(/web\.published_at IS NOT NULL AND web\.visibility != 'only_me'/.test(read('api/cancellation-policy/public.js')), 'a private or unpublished site name does not lead to its business');
  const members = read('api/shops/[id]/members.js');
  assert(!/hasAccount: out\.hasAccount/.test(members) && !/reason: out\.reason/.test(members), 'a shop invite does not say whether the address already has an account');
  const disc = read('api/me/discover.js');
  assert(/discover:u:\$\{user\.id\}/.test(disc) && /Math\.round\(Number\(r\.lat\) \* 1000\) \/ 1000/.test(disc), 'the directory is capped per account and gives a block-level map point, not the exact one');
  const prod = read('api/site/[handle]/products.js');
  assert(/loadPublicSite/.test(prod) && /stockQty:\s+null/.test(prod) && /loadWorkspaceAccess/.test(prod), 'the storefront follows the site\'s own privacy and says in stock or not, never how many');

  console.log('\n[7] what goes wrong inside stays inside');
  const dbErr = Object.assign(new Error('duplicate key value violates unique constraint "clients_workspace_email_key"'), { code: '23505' });
  assert(!/constraint|clients_workspace/.test(toolErrorText(dbErr)) && /nothing was changed/.test(toolErrorText(dbErr)), 'a database error never reaches Ivy\'s reply');
  assert(!/relation/.test(toolErrorText(new Error('relation "foo" does not exist'))) && !/fetch/.test(toolErrorText(new Error('fetch failed'))) && !/reading/.test(toolErrorText(new TypeError("Cannot read properties of undefined (reading 'id')"))), 'nor a missing table, a network fault or a code fault');
  assert(toolErrorText(new Error('No client by that name.')) === 'No client by that name.', 'a plain refusal written for the owner passes through');
  const longRefusal = `Jane Doe is already a client with that email (client id 84cbc290-cf82-4e99-af4d-f29bfcdb3cc1). Nothing was added; update their record instead (update_client). If this person already has two records, find_duplicate_clients and merge_clients will join them. ${'Tell the owner which record you found. '.repeat(6)}`;
  assert(longRefusal.length > 400 && toolErrorText(new Error(longRefusal)) === longRefusal.trim(), 'so does a long one: Ivy needs the whole instruction to act on it');
  const customerFacing = ['src/features/finance/Finance.jsx', 'src/features/onboarding/OnboardingPage.jsx', 'src/features/calendar/SyncDrawer.jsx', 'api/billing/checkout.js', 'api/calendar/google/connect.js'];
  const leaks = customerFacing.filter((p) => /(badRequest\(res, |body: |title: |>\s*)[^\n]*(STRIPE_SECRET_KEY|GOOGLE_OAUTH_CLIENT|IVY_STRIPE_PRICE_ID|in Vercel|Vercel env|env var)/.test(read(p)));
  assert(leaks.length === 0, `no customer-facing message names an internal setting or the hosting provider (${leaks.join(', ') || 'none'})`);
  const pricing = read('src/lib/pricing.js');
  assert(!/source:\s*'/.test(pricing) && /list price source: /.test(pricing), 'other products\' names are in comments, not in data sent to every browser');
  assert(!existsSync(new URL('../public/fonts/README.md', import.meta.url)), 'no internal note is served from the public folder');
  const keep = process.env.JWT_SECRET, keepEnv = process.env.NODE_ENV, keepCal = process.env.CALENDAR_INVITE_SECRET;
  const { signInvite } = await import('../api/_lib/calendarLinks.js');
  delete process.env.JWT_SECRET; delete process.env.CALENDAR_INVITE_SECRET; process.env.NODE_ENV = 'production';
  let threw = false; try { signInvite('b1'); } catch { threw = true; }
  process.env.JWT_SECRET = keep; process.env.NODE_ENV = keepEnv; if (keepCal) process.env.CALENDAR_INVITE_SECRET = keepCal;
  assert(threw, 'on the live site a signed link refuses to be made without its secret');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const id of users) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
