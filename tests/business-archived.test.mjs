// When an owner's subscription is no longer active, everything their
// CLIENTS could reach is archived, not just the owner's dashboard:
//   • the shared predicate (api/_lib/businessAccess.js) agrees with the
//     paywall: active / comped are open, ended trial / cancelled are not
//   • public booking page GET → 200 { archived, businessName, discoverPath }
//     with no services/slots; booking POST + contact POST → 403 business_archived
//   • website JSON (by handle + by host) → archived marker, no pages;
//     the SSR page is a static noindex card with the copy + Discover link
//     and no inline script; robots disallows all
//   • client portal: memberships/threads carry `archived`, client message
//     POST (1:1 + group) → 403; bookings/packages carry the flag
//   • program / gift-card / package / membership / store checkouts → 403;
//     the public program page → archived marker
//   • existing invoices stay payable: invoice-view GET still 200
//   • reactivating (status active + period_end in the future) flips every
//     surface back without touching any other data
//
// Run: node --import ./tests/bootstrap.mjs ./tests/business-archived.test.mjs
import crypto from 'node:crypto';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import {
  loadWorkspaceAccess, workspaceAccessBySlug, workspaceAccessByHandle,
  ARCHIVED_MESSAGE, DISCOVER_PATH, renderArchivedHtml,
} from '../api/_lib/businessAccess.js';
import bookingHandler from '../api/calendar/public/[slug].js';
import contactHandler from '../api/calendar/public/contact.js';
import websiteHandler from '../api/website/public/[handle].js';
import byHostHandler from '../api/website/by-host.js';
import ssrHandler from '../api/site/[handle]/index.js';
import ssrSlugHandler from '../api/site/[handle]/[slug].js';
import robotsHandler from '../api/site/[handle]/robots.txt.js';
import sitemapHandler from '../api/site/[handle]/sitemap.xml.js';
import storeCheckoutHandler from '../api/site/[handle]/checkout.js';
import meHandler from '../api/me/index.js';
import threadsHandler from '../api/me/threads/index.js';
import threadHandler from '../api/me/threads/[id].js';
import groupMessagesHandler from '../api/me/groups/[id]/messages.js';
import meBookingsHandler from '../api/me/bookings.js';
import mePackagesHandler from '../api/me/packages.js';
import programPublicHandler from '../api/programs/public/[id].js';
import programCheckoutHandler from '../api/programs/checkout.js';
import giftCardCheckoutHandler from '../api/gift-cards/checkout.js';
import packageCheckoutHandler from '../api/packages/checkout.js';
import membershipCheckoutHandler from '../api/memberships/checkout.js';
import invoiceViewHandler from '../api/invoice-view/[token].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
// No outbound network in tests (Stripe, push, mail).
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' });

function mockRes() {
  return { statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
    writeHead(c) { this.statusCode = c; return this; } };
}
const req = ({ method = 'GET', cookie, query = {}, body = {}, host = 'localhost:3000' } = {}) => ({
  method, url: '/t', query, body,
  headers: { 'content-type': 'application/json', origin: `http://${host}`, host,
    'x-forwarded-for': '198.18.9.9', ...(cookie ? { cookie } : {}) },
});
async function call(handler, r) { const res = mockRes(); await handler(r, res); return res; }

const STAMP = Date.now();
const ids = { users: [] };
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

// One business with everything a client could reach. `sub` is the raw
// subscription state on the workspace row.
async function mkBiz(label, sub) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`ba-${label}-${STAMP}@example.com`}, 'x', ${label}, NOW()) RETURNING id`;
  ids.users.push(u.rows[0].id);
  const w = await sql`INSERT INTO workspaces (owner_id, name, subscription_status, trial_ends_at, subscription_period_end, comp_until)
    VALUES (${u.rows[0].id}, ${label}, ${sub.status}, ${sub.trialEndsAt || null}, ${sub.periodEnd || null}, ${sub.compUntil || null}) RETURNING id`;
  const wid = w.rows[0].id;
  const slug = `ba-${label}-${STAMP}`;
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug)
    VALUES (${wid}, ${`${label} Studio`}, ${slug})
    ON CONFLICT (workspace_id) DO UPDATE SET slug = ${slug}, biz_name = ${`${label} Studio`}`;
  await sql`INSERT INTO services (workspace_id, name, price, duration_minutes, visibility)
    VALUES (${wid}, 'Session', 50, 60, 'public')`;
  // The public read serves the PUBLISHED snapshot (published_sections /
  // published_pages), so the fixture fills both the draft and the snapshot.
  const sections = '[{"id":"h","type":"hero","visible":true,"data":{"headline":"Hello"}}]';
  const pages = '[{"slug":"","title":"Home","sections":[{"id":"h","type":"hero","visible":true,"data":{"headline":"Hello"}}]},{"slug":"about","title":"About","sections":[]}]';
  await sql`INSERT INTO websites (workspace_id, handle, business_name, template, sections, pages, published_sections, published_pages, visibility, launched, published_at, custom_domain, domain_status)
    VALUES (${wid}, ${slug}, ${`${label} Studio`}, 'clean',
            ${sections}::jsonb, ${pages}::jsonb, ${sections}::jsonb, ${pages}::jsonb,
            'public', TRUE, NOW(), ${`${slug}.example.com`}, 'verified')
    ON CONFLICT (workspace_id) DO UPDATE SET handle = ${slug}, published_at = NOW()`;
  const program = (await sql`INSERT INTO programs (workspace_id, title, price_cents, status)
    VALUES (${wid}, 'Course', 2500, 'published') RETURNING id`).rows[0].id;
  return { userId: u.rows[0].id, wid, slug, program, name: `${label} Studio` };
}

// A portal user who is a client of `biz`, with a 1:1 thread.
async function mkClient(label, biz) {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`ba-client-${label}-${STAMP}@example.com`}, 'x', 'Casey', NOW()) RETURNING id`;
  ids.users.push(u.rows[0].id);
  const c = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id)
    VALUES (${biz.wid}, 'Casey', ${`ba-client-${label}-${STAMP}@example.com`}, 'active', ${u.rows[0].id}) RETURNING id`).rows[0].id;
  const t = (await sql`INSERT INTO message_threads (workspace_id, client_id) VALUES (${biz.wid}, ${c}) RETURNING id`).rows[0].id;
  return { userId: u.rows[0].id, clientId: c, threadId: t, cookie: `ivy_session=${signSession(u.rows[0].id)}` };
}

const future = () => new Date(Date.now() + 30 * 864e5);
const past   = () => new Date(Date.now() - 2 * 864e5);
// A Tuesday 7 to 13 days out: inside the default 60-day horizon, past
// the 24h notice, and inside the default Tue 9:00-17:00 availability.
function nextBookableDate() {
  const d = new Date(Date.now() + 7 * 864e5);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function run() {
  await ensureSchemaApplied();

  console.log('\n[1] predicate: active vs ended trial vs cancelled vs comped');
  const active    = await mkBiz('active',    { status: 'active',    periodEnd: future() });
  const ended     = await mkBiz('ended',     { status: 'trialing',  trialEndsAt: past() });
  const cancelled = await mkBiz('cancelled', { status: 'cancelled', periodEnd: past() });
  const comped    = await mkBiz('comped',    { status: 'cancelled', compUntil: future() });
  assert((await loadWorkspaceAccess(active.wid)).active === true, 'active + period in the future → active');
  assert((await loadWorkspaceAccess(ended.wid)).active === false, 'trialing + trial ended → archived');
  assert((await loadWorkspaceAccess(cancelled.wid)).active === false, 'cancelled → archived');
  assert((await loadWorkspaceAccess(comped.wid)).active === true, 'comped (comp_until in the future) → active');
  const bySlug = await workspaceAccessBySlug(ended.slug);
  assert(bySlug.workspaceId === ended.wid && bySlug.active === false && bySlug.businessName === ended.name, 'bySlug resolves id, state and business name');
  const byHandle = await workspaceAccessByHandle(active.slug);
  assert(byHandle.workspaceId === active.wid && byHandle.active === true, 'byHandle resolves the website handle');
  assert((await loadWorkspaceAccess(null)).active === false && (await workspaceAccessBySlug('nope-' + STAMP)).workspaceId === null, 'unknown ids are not active');

  console.log('\n[2] public booking page');
  let r = await call(bookingHandler, req({ query: { slug: active.slug } }));
  assert(r.statusCode === 200 && r.body.calendar?.services?.length === 1 && !r.body.archived, 'active: calendar with services');
  r = await call(bookingHandler, req({ query: { slug: ended.slug } }));
  assert(r.statusCode === 200 && r.body.archived === true, 'ended trial: GET 200 with archived: true');
  assert(r.body.businessName === ended.name && r.body.discoverPath === DISCOVER_PATH, 'archived payload carries businessName + discoverPath');
  assert(r.body.calendar === undefined, 'archived payload carries no services or slots');
  r = await call(bookingHandler, req({ query: { slug: cancelled.slug } }));
  assert(r.body.archived === true, 'cancelled: archived too');
  r = await call(bookingHandler, req({ query: { slug: comped.slug } }));
  assert(r.statusCode === 200 && !!r.body.calendar, 'comped: booking page open');
  const svc = (await sql`SELECT id FROM services WHERE workspace_id = ${ended.wid}`).rows[0].id;
  const bookBody = { serviceId: svc, date: nextBookableDate(), startMin: 600, endMin: 660, clientName: 'Pat', clientEmail: `pat-${STAMP}@example.com` };
  r = await call(bookingHandler, req({ method: 'POST', query: { slug: ended.slug }, body: bookBody }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived' && r.body.error === ARCHIVED_MESSAGE, 'booking POST → 403 business_archived');
  const n = (await sql`SELECT COUNT(*)::int AS n FROM bookings WHERE workspace_id = ${ended.wid}`).rows[0].n;
  assert(n === 0, 'no booking row was written');
  r = await call(contactHandler, req({ method: 'POST', query: { slug: ended.slug }, body: { name: 'Pat', email: `pat2-${STAMP}@example.com`, message: 'Hi' } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'contact POST → 403 business_archived');
  const leads = (await sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${ended.wid} AND email = ${`pat2-${STAMP}@example.com`}`).rows[0].n;
  assert(leads === 0, 'no lead row was written');
  r = await call(bookingHandler, req({ query: { slug: 'missing-' + STAMP } }));
  assert(r.statusCode === 404, 'unknown slug still 404s (not archived)');

  console.log('\n[3] public website: JSON + SSR + robots + sitemap');
  r = await call(websiteHandler, req({ query: { handle: active.slug } }));
  assert(r.statusCode === 200 && r.body.site?.page?.sections?.length === 1, 'active: site JSON with pages');
  r = await call(websiteHandler, req({ query: { handle: ended.slug } }));
  assert(r.statusCode === 200 && r.body.archived === true && r.body.site === undefined, 'archived: site JSON is the marker only');
  assert(r.body.businessName === ended.name && r.body.discoverPath === DISCOVER_PATH, 'website payload carries businessName + discoverPath');
  r = await call(websiteHandler, req({ query: { handle: ended.slug, slug: 'about' } }));
  assert(r.body.archived === true, 'archived: sub-page JSON is the marker too');
  r = await call(byHostHandler, req({ host: `${ended.slug}.example.com` }));
  assert(r.statusCode === 200 && r.body.archived === true && r.body.businessName === ended.name, 'by-host (custom domain): archived marker');
  r = await call(byHostHandler, req({ host: `${active.slug}.example.com` }));
  assert(r.statusCode === 200 && !!r.body.site, 'by-host active: site');

  r = await call(ssrHandler, req({ query: { handle: ended.slug } }));
  const html = String(r.body);
  assert(r.statusCode === 200 && r.headers['content-type'].startsWith('text/html'), 'SSR archived: 200 text/html');
  assert(html.includes(ARCHIVED_MESSAGE), 'SSR archived: contains the archived line');
  assert(html.includes('Want to see what else is out there?') && html.includes('Check out Discover'), 'SSR archived: contains the prompt + button label');
  assert(html.includes('href="https://www.joinivy.ai/me/discover"'), 'SSR archived: links to Discover');
  assert(html.includes(ended.name), 'SSR archived: shows the business name');
  assert(/<meta name="robots" content="noindex/.test(html), 'SSR archived: noindex meta');
  assert(!/<script/i.test(html), 'SSR archived: no script tags (CSP has no unsafe-inline)');
  assert(!html.includes('Hello'), 'SSR archived: site content is not rendered');
  assert(r.headers['cache-control'] === 'no-store', 'SSR archived: not edge-cached, so a resubscribe is instant');
  r = await call(ssrSlugHandler, req({ query: { handle: ended.slug, slug: 'about' } }));
  assert(r.statusCode === 200 && String(r.body).includes(ARCHIVED_MESSAGE) && !/<script/i.test(String(r.body)), 'SSR sub-page archived: same static card');
  r = await call(ssrHandler, req({ query: { handle: active.slug } }));
  assert(r.statusCode === 200 && String(r.body).includes('Hello') && !String(r.body).includes(ARCHIVED_MESSAGE), 'SSR active: real site');
  assert(renderArchivedHtml({ businessName: '<b>x</b>' }).includes('&lt;b&gt;x&lt;/b&gt;'), 'SSR archived: business name is escaped');

  r = await call(robotsHandler, req({ query: { handle: ended.slug } }));
  assert(r.statusCode === 200 && /Disallow: \/\s*$/m.test(String(r.body)) && !/Allow: \//.test(String(r.body)), 'robots archived: disallow all');
  r = await call(robotsHandler, req({ query: { handle: active.slug } }));
  assert(/Allow: \//.test(String(r.body)) && /Sitemap:/.test(String(r.body)), 'robots active: allow + sitemap');
  r = await call(sitemapHandler, req({ query: { handle: ended.slug } }));
  assert(r.statusCode === 200 && !String(r.body).includes('<loc>'), 'sitemap archived: no URLs');
  r = await call(sitemapHandler, req({ query: { handle: active.slug } }));
  assert(String(r.body).includes('<loc>'), 'sitemap active: lists pages');

  console.log('\n[4] client portal');
  const casey = await mkClient('ended', ended);
  const dana  = await mkClient('active', active);
  r = await call(meHandler, req({ cookie: casey.cookie }));
  const mem = r.body.memberships.find((m) => m.clientId === casey.clientId);
  assert(r.statusCode === 200 && mem?.archived === true && mem.businessName === ended.name, '/api/me membership carries archived: true');
  r = await call(meHandler, req({ cookie: dana.cookie }));
  assert(r.body.memberships.find((m) => m.clientId === dana.clientId)?.archived === false, '/api/me membership of an active business: archived: false');

  r = await call(threadsHandler, req({ cookie: casey.cookie }));
  assert(r.statusCode === 200 && r.body.threads[0]?.archived === true, 'thread list carries archived');
  r = await call(threadHandler, req({ cookie: casey.cookie, query: { id: casey.threadId } }));
  assert(r.statusCode === 200 && r.body.thread.archived === true && Array.isArray(r.body.messages), 'thread GET still readable, flagged archived');
  r = await call(threadHandler, req({ method: 'POST', cookie: casey.cookie, query: { id: casey.threadId }, body: { text: 'hello?' } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'client thread POST → 403 business_archived');
  const msgs = (await sql`SELECT COUNT(*)::int AS n FROM messages WHERE thread_id = ${casey.threadId}`).rows[0].n;
  assert(msgs === 0, 'no message row was written');
  r = await call(threadHandler, req({ method: 'POST', cookie: dana.cookie, query: { id: dana.threadId }, body: { text: 'hello!' } }));
  assert(r.statusCode === 201, 'active business: client thread POST → 201');

  const gid = (await sql`INSERT INTO group_threads (workspace_id, name, mode) VALUES (${ended.wid}, 'Cohort', 'open') RETURNING id`).rows[0].id;
  await sql`INSERT INTO group_thread_members (thread_id, workspace_id, client_id) VALUES (${gid}, ${ended.wid}, ${casey.clientId})`;
  r = await call(groupMessagesHandler, req({ method: 'POST', cookie: casey.cookie, query: { id: gid }, body: { text: 'anyone?' } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'client group message POST → 403 business_archived');

  await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min)
    VALUES (${ended.wid}, ${svc}, ${casey.clientId}, 'Casey', 'c@example.com', '2031-02-02', 600, 660)`;
  r = await call(meBookingsHandler, req({ cookie: casey.cookie }));
  assert(r.statusCode === 200 && r.body.upcoming?.[0]?.archived === true, '/me/bookings row carries archived (cancel stays possible, reschedule hidden)');
  r = await call(mePackagesHandler, req({ cookie: casey.cookie }));
  assert(r.statusCode === 200 && Array.isArray(r.body.packages), '/me/packages still answers for an archived business');

  console.log('\n[5] other public purchases');
  r = await call(programPublicHandler, req({ query: { id: ended.program } }));
  assert(r.statusCode === 200 && r.body.archived === true && r.body.program === undefined, 'program public page → archived marker, no program');
  r = await call(programPublicHandler, req({ query: { id: active.program } }));
  assert(r.statusCode === 200 && !!r.body.program, 'active program public page → program');
  const buyer = { name: 'Pat', email: `buyer-${STAMP}@example.com` };
  r = await call(programCheckoutHandler, req({ method: 'POST', body: { programId: ended.program, ...buyer } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'program checkout → 403');
  r = await call(giftCardCheckoutHandler, req({ method: 'POST', body: { slug: ended.slug, amountCents: 5000, senderName: 'Pat', senderEmail: buyer.email, recipientName: 'Sam', recipientEmail: `sam-${STAMP}@example.com` } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'gift card checkout → 403');
  r = await call(packageCheckoutHandler, req({ method: 'POST', body: { slug: ended.slug, packageId: '00000000-0000-0000-0000-000000000000', ...buyer } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'package checkout → 403');
  r = await call(membershipCheckoutHandler, req({ method: 'POST', body: { slug: ended.slug, membershipId: '00000000-0000-0000-0000-000000000000', ...buyer } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'membership checkout → 403');
  r = await call(storeCheckoutHandler, req({ method: 'POST', query: { handle: ended.slug }, body: { items: [{ productId: '00000000-0000-0000-0000-000000000000', qty: 1 }], customer: buyer } }));
  assert(r.statusCode === 403 && r.body.code === 'business_archived', 'website store checkout → 403');
  const buyers = (await sql`SELECT COUNT(*)::int AS n FROM clients WHERE workspace_id = ${ended.wid} AND email = ${buyer.email}`).rows[0].n;
  assert(buyers === 0, 'no buyer client row was written by any checkout');

  console.log('\n[6] money owed + paperwork already sent stay reachable');
  const token = `inv-${STAMP}-${Math.random().toString(36).slice(2)}`;
  await sql.query(
    `INSERT INTO invoices (workspace_id, number, client_id, client_name, client_email, issue_date, due_date, items, status, view_token_hash)
     VALUES ($1,'INV-BA1',$2,'Casey','c@example.com',CURRENT_DATE,CURRENT_DATE,$3::jsonb,'sent',$4)`,
    [ended.wid, casey.clientId, JSON.stringify([{ id: 'l', description: 'Session', quantity: 1, rate: 80 }]), hash(token)],
  );
  r = await call(invoiceViewHandler, req({ query: { token } }));
  assert(r.statusCode === 200 && r.body.invoice, 'invoice-view GET still 200 for an archived business');

  console.log('\n[7] reactivation flips everything back, data untouched');
  const before = await sql`SELECT (SELECT COUNT(*) FROM services WHERE workspace_id = ${ended.wid})::int AS s,
    (SELECT COUNT(*) FROM clients WHERE workspace_id = ${ended.wid})::int AS c,
    (SELECT pages FROM websites WHERE workspace_id = ${ended.wid}) AS pages`;
  await sql`UPDATE workspaces SET subscription_status = 'active', subscription_period_end = NOW() + INTERVAL '30 days' WHERE id = ${ended.wid}`;
  assert((await loadWorkspaceAccess(ended.wid)).active === true, 'predicate: active again');
  r = await call(bookingHandler, req({ query: { slug: ended.slug } }));
  assert(r.statusCode === 200 && r.body.calendar?.services?.length === 1 && !r.body.archived, 'booking page: calendar is back');
  r = await call(bookingHandler, req({ method: 'POST', query: { slug: ended.slug }, body: bookBody }));
  assert(r.statusCode === 201 && r.body.booking, `booking POST works again (got ${r.statusCode} ${r.body?.error || ''})`);
  r = await call(contactHandler, req({ method: 'POST', query: { slug: ended.slug }, body: { name: 'Pat', email: `pat2-${STAMP}@example.com`, message: 'Hi' } }));
  assert(r.statusCode === 200 || r.statusCode === 201, `contact POST works again (got ${r.statusCode})`);
  r = await call(websiteHandler, req({ query: { handle: ended.slug } }));
  assert(r.statusCode === 200 && !!r.body.site && !r.body.archived, 'website JSON: site is back');
  r = await call(byHostHandler, req({ host: `${ended.slug}.example.com` }));
  assert(!!r.body.site, 'by-host: site is back');
  r = await call(ssrHandler, req({ query: { handle: ended.slug } }));
  assert(String(r.body).includes('Hello') && !String(r.body).includes(ARCHIVED_MESSAGE), 'SSR: real site is back');
  r = await call(robotsHandler, req({ query: { handle: ended.slug } }));
  assert(/Allow: \//.test(String(r.body)), 'robots: allow is back');
  r = await call(meHandler, req({ cookie: casey.cookie }));
  assert(r.body.memberships.find((m) => m.clientId === casey.clientId)?.archived === false, 'portal membership: archived false');
  r = await call(threadHandler, req({ method: 'POST', cookie: casey.cookie, query: { id: casey.threadId }, body: { text: 'hello again' } }));
  assert(r.statusCode === 201, 'client thread POST: 201 again');
  r = await call(programPublicHandler, req({ query: { id: ended.program } }));
  assert(!!r.body.program, 'program public page: program is back');
  const after = await sql`SELECT (SELECT COUNT(*) FROM services WHERE workspace_id = ${ended.wid})::int AS s,
    (SELECT COUNT(*) FROM clients WHERE workspace_id = ${ended.wid})::int AS c,
    (SELECT pages FROM websites WHERE workspace_id = ${ended.wid}) AS pages`;
  assert(before.rows[0].s === after.rows[0].s && JSON.stringify(before.rows[0].pages) === JSON.stringify(after.rows[0].pages), 'archiving + reactivating changed no services or website data');
  assert(after.rows[0].c === before.rows[0].c + 2, "the only new client rows are the booking + contact lead made after reactivation");

  // Lapse again: the archive is a pure function of the row.
  await sql`UPDATE workspaces SET subscription_status = 'suspended' WHERE id = ${ended.wid}`;
  r = await call(bookingHandler, req({ query: { slug: ended.slug } }));
  assert(r.body.archived === true, 'suspended again → archived again, instantly');
}

async function cleanup() {
  for (const id of ids.users) {
    await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
  }
}

run()
  .catch((err) => { console.error('Fatal:', err.stack || err.message); fail++; })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
