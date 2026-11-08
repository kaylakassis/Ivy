// Shop pages (1.0.6): one location, many independent Ivy businesses.
//
//   [1]  create: owner becomes first member; slug rules; helpers refused
//   [2]  invites: token hashed + expires, wrong account refused, one use,
//        nothing shown before accept
//   [3]  isolation: owner sees counts only; member A cannot read member B;
//        outsiders get 404; a member can only pick their own services
//   [4]  public payload: chosen public services only, no private data
//   [5]  first available: true soonest slot across members, books in the
//        right workspace exactly once under concurrency, owner told
//   [6]  reviews: count-weighted shop rating
//   [7]  leave / remove / lapsed plan: listing vanishes at once
//   [8]  join link: works once per business, regenerating kills the old one
//   [9]  publish gating, archived owner
//   [10] Ivy: held before approval, scoped to the owner
//   [11] server-rendered page: title, canonical, OG, JSON-LD; sitemap; config
//   [12] booking page + Discover + accountability hooks
//
// Run: node --import ./tests/bootstrap.mjs ./tests/shops.test.mjs
process.env.APP_URL = 'https://www.joinivy.ai';

import crypto from 'node:crypto';
import fs from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import shopsIndex from '../api/shops/index.js';
import shopById from '../api/shops/[id]/index.js';
import publishH from '../api/shops/[id]/publish.js';
import membersH from '../api/shops/[id]/members.js';
import listingH from '../api/shops/[id]/listing.js';
import joinLinkH from '../api/shops/[id]/join-link.js';
import inviteH from '../api/shops/invite.js';
import slugCheckH from '../api/shops/slug-check.js';
import shopDataH from '../api/shop/[slug]/data.js';
import shopHtmlH from '../api/shop/[slug]/index.js';
import sitemapH from '../api/shop/sitemap.xml.js';
import publicBooking from '../api/calendar/public/[slug].js';
import discoverH from '../api/me/discover.js';
import { planAppAction, appToolNeedsApproval, appCallIsRead, APP_HANDLERS } from '../api/_lib/ivyAppTools.js';
import { shopInvitesWaiting } from '../api/_lib/shops.js';
import { groupServices, firstAvailable, shopRating } from '../src/features/shops/shopHelpers.js';
import { addDays, fmtDateISO } from '../src/features/calendar/utils.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Capture outbound email.
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('resend.com')) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'em_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
const mailsTo = (addr) => sent.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).map((x) => String(x).toLowerCase()).includes(addr.toLowerCase()));

const mkRes = () => {
  const r = { statusCode: 200, body: null, headers: {}, writableEnded: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.getHeader = (k) => r.headers[k.toLowerCase()];
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.writableEnded = true; return r; };
  r.send = (b) => { r.body = b; r.writableEnded = true; return r; };
  r.end = (b) => { if (b !== undefined) r.body = b; r.writableEnded = true; return r; };
  return r;
};
let ipN = 0;
const ip = () => `203.0.113.${(ipN++ % 200) + 20}`;
const cookieFor = (uid) => `ivy_session=${signSession(uid)}`;
async function call(handler, { method = 'GET', query = {}, body, user = null, headers = {} }) {
  const res = mkRes();
  const req = {
    method, url: '/test', query, body,
    headers: {
      'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': ip(), ...(user ? { cookie: cookieFor(user.id) } : {}), ...headers,
    },
  };
  await handler(req, res);
  return res;
}

const created = { users: [] };
async function mkOwner(tag, biz, { status = 'active', slot = 30 } = {}) {
  const email = `shop-${tag}-${S}@example.com`;
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${email}, 'x', ${`${tag[0].toUpperCase()}${tag.slice(1)} Person`}, NOW(), '2026-05-05', NOW()) RETURNING id, name`).rows[0];
  const w = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, ${biz}, ${status}, NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0];
  const slug = `shop-${tag}-${S}`.toLowerCase();
  const avail = JSON.stringify({ 0: [{ start: 540, end: 1020 }], 1: [{ start: 540, end: 1020 }], 2: [{ start: 540, end: 1020 }], 3: [{ start: 540, end: 1020 }], 4: [{ start: 540, end: 1020 }], 5: [{ start: 540, end: 1020 }], 6: [{ start: 540, end: 1020 }] });
  await sql`INSERT INTO calendar_settings (workspace_id, slug, biz_name, timezone, availability, slot_minutes, min_notice_hours, max_advance_days, address_label)
    VALUES (${w.id}, ${slug}, ${biz}, 'UTC', ${avail}::jsonb, ${slot}, 0, 60, '12 Shop Street')
    ON CONFLICT (workspace_id) DO UPDATE SET slug = EXCLUDED.slug, biz_name = EXCLUDED.biz_name, timezone = 'UTC', availability = EXCLUDED.availability, slot_minutes = EXCLUDED.slot_minutes, min_notice_hours = 0, max_advance_days = 60`;
  created.users.push(u.id);
  return { id: u.id, email, ws: w.id, slug, biz, name: u.name };
}
async function mkService(ws, name, price, dur = 60, visibility = 'public') {
  return (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price, visibility) VALUES (${ws}, ${name}, ${dur}, ${price}, ${visibility}) RETURNING id`).rows[0].id;
}
const tomorrow = addDays(new Date(), 1); tomorrow.setHours(0, 0, 0, 0);
const T = fmtDateISO(tomorrow);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tokenFromMail = (m) => (String(m.html).match(/\/shops\/invite\/([A-Za-z0-9_\-%.]+)/) || [])[1];

async function main() {
  await ensureSchemaApplied();
  const A = await mkOwner('alpha', 'Alpha Barbers');   // shop owner
  const B = await mkOwner('bravo', 'Bravo Cuts');      // member via email
  const C = await mkOwner('charlie', 'Charlie Color'); // member, later removed
  const D = await mkOwner('delta', 'Delta Beards');    // joins via link, then plan lapses
  const E = await mkOwner('echo', 'Echo Nails');       // outsider
  const aFade = await mkService(A.ws, 'Fade', 45);
  const bFade = await mkService(B.ws, 'Fade', 35);
  const bPrivate = await mkService(B.ws, 'Secret VIP cut', 500, 60, 'private');
  const bHidden = await mkService(B.ws, 'Draft thing', 10, 60, 'only_me');
  const bBeard = await mkService(B.ws, 'Beard trim', 20, 30);
  const cFade = await mkService(C.ws, 'Fade', 30);
  const dBeard = await mkService(D.ws, 'Beard trim', 25, 30);

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[1] create');
  let r = await call(shopsIndex, { method: 'POST', user: A, body: { name: 'Main Street Barbers', slug: `main-street-${S}` } });
  assert(r.statusCode === 201 && r.body.shop.slug === `main-street-${S}` && r.body.shop.status === 'draft', 'owner creates a draft shop');
  const shop = r.body.shop;
  const ownerRow = (await sql`SELECT * FROM shop_members WHERE shop_id = ${shop.id} AND workspace_id = ${A.ws}`).rows[0];
  assert(ownerRow?.role === 'owner' && ownerRow.status === 'active', 'owner is the first member, no invite needed');
  assert(JSON.stringify(shop.hours).includes('"start":540'), 'hours copied from the owner calendar');
  r = await call(shopsIndex, { method: 'POST', user: B, body: { name: 'Dup', slug: `main-street-${S}` } });
  assert(r.statusCode === 409 && r.body.code === 'slug_taken', 'taken slug → 409');
  r = await call(shopsIndex, { method: 'POST', user: B, body: { name: 'Bad', slug: 'admin' } });
  assert(r.statusCode === 400, 'reserved slug refused');
  r = await call(shopsIndex, { method: 'POST', user: B, body: { name: 'Bad', slug: 'Has Spaces!' } });
  assert(r.statusCode === 400, 'invalid slug refused');
  r = await call(slugCheckH, { user: B, query: { slug: `main-street-${S}` } });
  assert(r.statusCode === 200 && r.body.valid && !r.body.available, 'slug check says taken');
  r = await call(slugCheckH, { user: B, query: { slug: `free-${S}` } });
  assert(r.body.available === true, 'slug check says available');
  // A helper (someone acting for A with the helper header) never reaches shop management.
  await sql`INSERT INTO staff_members (workspace_id, name, email, user_id, active) VALUES (${A.ws}, 'Helper', ${E.email}, ${E.id}, TRUE)`;
  r = await call(shopsIndex, { method: 'GET', user: E, headers: { 'x-helper-workspace': A.ws } });
  assert(r.statusCode === 403, 'helper header → 403');
  r = await call(shopById, { method: 'PATCH', user: A, query: { id: shop.id }, body: { hours: { 1: [{ start: 600, end: 500 }] } } });
  assert(r.statusCode === 400, 'bad hours refused');
  r = await call(shopById, { method: 'PATCH', user: A, query: { id: shop.id }, body: { amenities: ['jacuzzi'] } });
  assert(r.statusCode === 400, 'unknown amenity refused');
  r = await call(shopById, { method: 'PATCH', user: A, query: { id: shop.id }, body: { photos: ['http://x.test/a.jpg'] } });
  assert(r.statusCode === 400, 'non-https photo refused');
  r = await call(shopById, { method: 'PATCH', user: A, query: { id: shop.id }, body: { tagline: 'Cuts and color under one roof', city: 'Austin', amenities: ['parking', 'walk_ins'], settings: { theme: 'warm', bookingRulesNote: 'Booked clients first.' }, addressLabel: '12 Shop Street, Austin' } });
  assert(r.statusCode === 200 && r.body.shop.settings.theme === 'warm' && r.body.shop.amenities.length === 2, 'owner edits details');
  r = await call(shopById, { method: 'PATCH', user: B, query: { id: shop.id }, body: { name: 'Hijack' } });
  assert(r.statusCode === 404, 'non-owner cannot edit (404, no hint)');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[2] invites');
  r = await call(membersH, { method: 'POST', user: A, query: { id: shop.id }, body: { email: B.email } });
  assert(r.statusCode === 201 && r.body.sent && r.body.hasAccount && r.body.member.status === 'invited', 'invite by email sent');
  const inviteMail = mailsTo(B.email).pop();
  assert(/invited you to be listed on their shop page/.test(inviteMail.subject), 'invite subject');
  assert(/Your clients/.test(inviteMail.html) && /never shows/.test(inviteMail.html) && /leave the shop page at any time/.test(inviteMail.html), 'email says what shows, what never shows, and that leaving is one tap');
  const rawB = decodeURIComponent(tokenFromMail(inviteMail));
  const memberRowB = (await sql`SELECT * FROM shop_members WHERE shop_id = ${shop.id} AND invite_email = ${B.email}`).rows[0];
  assert(rawB.length >= 32 && memberRowB.invite_token_hash === sha(rawB) && memberRowB.invite_token_hash !== rawB, 'token is long, random and stored hashed');
  assert(new Date(memberRowB.invite_expires_at) - Date.now() > 13 * 86400 * 1000, 'expires in about 14 days');
  assert(memberRowB.workspace_id === B.ws, 'an existing Ivy business is bound right away');
  await wait(400);
  const bellB = await sql`SELECT * FROM notifications WHERE user_id = ${B.id} AND type = 'shops'`;
  assert(bellB.rows.length === 1 && /invited you/.test(bellB.rows[0].title), 'invitee gets a bell/push of type shops');
  // Publish so the public payload exists; B must NOT be on it yet.
  r = await call(publishH, { method: 'POST', user: A, query: { id: shop.id }, body: { status: 'published' } });
  assert(r.statusCode === 200 && r.body.shop.status === 'published', 'owner publishes');
  r = await call(shopDataH, { query: { slug: shop.slug } });
  assert(r.statusCode === 200 && r.body.members.length === 1 && r.body.members[0].businessName === 'Alpha Barbers', 'before accept: only the owner is on the page');
  r = await call(inviteH, { query: { token: 'nope-nope-nope-nope-nope' } });
  assert(r.statusCode === 410, 'unknown token → 410');
  r = await call(inviteH, { query: { token: rawB } });
  assert(r.statusCode === 200 && r.body.kind === 'member' && r.body.email === B.email && r.body.shared.length === 4 && r.body.neverShared.length === 3, 'invite preview shows the promise');
  r = await call(inviteH, { method: 'POST', user: C, body: { token: rawB, action: 'accept' } });
  assert(r.statusCode === 403 && r.body.code === 'wrong_email', 'another business cannot accept B\'s invite');
  r = await call(inviteH, { method: 'POST', user: B, body: { token: rawB, action: 'accept' } });
  assert(r.statusCode === 200 && r.body.joined === true, 'B accepts');
  r = await call(inviteH, { method: 'POST', user: B, body: { token: rawB, action: 'accept' } });
  assert(r.statusCode === 410, 'a used token is dead');
  const bellA = await sql`SELECT * FROM notifications WHERE user_id = ${A.id} AND type = 'shops' ORDER BY created_at DESC`;
  assert(bellA.rows.some((n) => /Bravo Cuts joined/.test(n.title)), 'owner is told who joined');
  await wait(300);
  assert(mailsTo(A.email).some((m) => /joined/.test(m.subject)), 'owner gets the joined email');
  // Expired invite for C.
  r = await call(membersH, { method: 'POST', user: A, query: { id: shop.id }, body: { email: C.email } });
  const rawC = decodeURIComponent(tokenFromMail(mailsTo(C.email).pop()));
  await sql`UPDATE shop_members SET invite_expires_at = NOW() - INTERVAL '1 minute' WHERE shop_id = ${shop.id} AND invite_email = ${C.email}`;
  r = await call(inviteH, { query: { token: rawC } });
  assert(r.statusCode === 410, 'expired token reads as dead');
  r = await call(inviteH, { method: 'POST', user: C, body: { token: rawC, action: 'accept' } });
  assert(r.statusCode === 410, 'expired token cannot be accepted');
  // Re-invite C (one live link; the old one is replaced) and accept from the in-app card by id.
  r = await call(membersH, { method: 'POST', user: A, query: { id: shop.id }, body: { email: C.email } });
  assert(r.statusCode === 201, 're-invite after expiry');
  const waiting = await shopInvitesWaiting(C.ws, C.email);
  assert(waiting.length === 1 && waiting[0].name === 'Main Street Barbers', 'accountability partner sees the waiting invite');
  r = await call(shopsIndex, { user: C });
  assert(r.body.invites.length === 1 && r.body.invites[0].shop.slug === shop.slug, 'C sees the invite card in the app');
  r = await call(inviteH, { method: 'POST', user: E, body: { inviteId: r.body.invites[0].inviteId, action: 'accept' } });
  assert(r.statusCode === 410, 'another account cannot accept C\'s in-app invite by id');
  r = await call(shopsIndex, { user: C });
  r = await call(inviteH, { method: 'POST', user: C, body: { inviteId: r.body.invites[0].inviteId, action: 'accept' } });
  assert(r.statusCode === 200 && r.body.joined, 'C accepts from the in-app card');
  r = await call(membersH, { method: 'POST', user: A, query: { id: shop.id }, body: { email: C.email } });
  assert(r.statusCode === 409, 'cannot invite someone already on the page');
  r = await call(membersH, { method: 'POST', user: A, query: { id: shop.id }, body: { email: A.email } });
  assert(r.statusCode === 400, 'cannot invite yourself');
  r = await call(membersH, { method: 'POST', user: B, query: { id: shop.id }, body: { email: E.email } });
  assert(r.statusCode === 404, 'a member cannot invite (owner only)');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[3] isolation');
  // Private data in B's workspace that must never leave it.
  const bClient = (await sql`INSERT INTO clients (workspace_id, name, email, phone, notes, stage) VALUES (${B.ws}, 'Priya Secret', ${`priya-${S}@example.com`}, '+15550001111', 'allergic to latex', 'active') RETURNING id`).rows[0];
  await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, client_phone, date, start_min, end_min, notes, shop_id)
    VALUES (${B.ws}, ${bFade}, ${bClient.id}, 'Priya Secret', ${`priya-${S}@example.com`}, '+15550001111', ${T}, 540, 600, 'private note', ${shop.id})`;
  await sql`INSERT INTO calendar_blocks (workspace_id, date, start_min, end_min, label, blocks_bookings) VALUES (${B.ws}, ${T}, 600, 720, 'Dentist appointment', TRUE)`;
  r = await call(shopById, { user: A, query: { id: shop.id } });
  assert(r.statusCode === 200 && r.body.role === 'owner' && r.body.members.length >= 3, 'owner reads the roster');
  const bRoster = r.body.members.find((m) => m.businessName === 'Bravo Cuts');
  assert(bRoster.stats.total === 1 && bRoster.services === undefined, 'owner sees counts for B, not B\'s services or clients');
  const ownerJson = JSON.stringify(r.body);
  assert(!ownerJson.includes('Priya') && !ownerJson.includes(`priya-${S}`) && !ownerJson.includes('555000') && !ownerJson.includes('latex') && !ownerJson.includes('Dentist') && !ownerJson.includes(B.ws), 'nothing private of B (client, phone, note, block, workspace id) in the owner payload');
  r = await call(shopById, { user: B, query: { id: shop.id } });
  assert(r.statusCode === 200 && r.body.role === 'member' && r.body.me.status === 'active' && r.body.myStats.total === 1 && !r.body.members, 'member reads only their own listing and counts');
  assert(r.body.services.some((s) => s.id === bFade) && !r.body.services.some((s) => s.id === bHidden), 'member sees their own services to choose from (hidden ones excluded)');
  r = await call(shopById, { user: E, query: { id: shop.id } });
  assert(r.statusCode === 404, 'outsider gets 404');
  r = await call(listingH, { method: 'PATCH', user: E, query: { id: shop.id }, body: { title: 'x' } });
  assert(r.statusCode === 404, 'outsider cannot edit a listing');
  r = await call(listingH, { method: 'PATCH', user: B, query: { id: shop.id }, body: { visibleServiceIds: [cFade] } });
  assert(r.statusCode === 400, 'B cannot list C\'s service as their own');
  r = await call(listingH, { method: 'PATCH', user: B, query: { id: shop.id }, body: { title: 'Barber', bio: 'Fades since 2010', visibleServiceIds: [bFade, bPrivate] } });
  assert(r.statusCode === 200 && r.body.me.title === 'Barber' && r.body.me.visibleServiceIds.length === 2, 'B edits their own listing');
  r = await call(membersH, { method: 'PATCH', user: A, query: { id: shop.id }, body: { items: [{ id: bRoster.id, featured: true, title: 'Head barber' }] } });
  assert(r.statusCode === 200 && r.body.members.find((m) => m.id === bRoster.id).featured === true, 'owner features a member and sets a title');
  r = await call(membersH, { method: 'DELETE', user: B, query: { id: shop.id }, body: { memberId: bRoster.id } });
  assert(r.statusCode === 404, 'a member cannot remove anyone');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[4] public payload');
  r = await call(shopDataH, { query: { slug: shop.slug } });
  assert(r.statusCode === 200 && r.body.members.length === 3, 'three members on the page');
  const pubB = r.body.members.find((m) => m.businessName === 'Bravo Cuts');
  assert(pubB.services.map((s) => s.id).sort().join() === [bFade].join(), 'only B\'s chosen PUBLIC service shows (private + hidden never do, even when chosen)');
  assert(pubB.title === 'Head barber' && pubB.bio === 'Fades since 2010' && pubB.featured === true && pubB.firstName === 'Bravo', 'listing fields and first name');
  const pubJson = JSON.stringify(r.body);
  assert(!pubJson.includes('Priya') && !pubJson.includes(`priya-${S}`) && !pubJson.includes('555000') && !pubJson.includes('latex') && !pubJson.includes('private note') && !pubJson.includes('Dentist'), 'no client name, email, phone, notes or block label in the public payload');
  assert(!pubJson.includes(B.ws) && !pubJson.includes(A.ws), 'no workspace ids leak');
  assert(pubB.blocks.some((b) => b.label === 'Busy' && b.startMin === 600) && pubB.bookings.length === 1 && !('clientName' in pubB.bookings[0]), 'blocks read "Busy"; bookings are redacted');
  assert(pubB.bookUrl === `/book/${B.slug}` && r.body.shop.settings.theme === 'warm' && r.body.shop.amenities.includes('parking'), 'book link, theme and amenities');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[5] first available + concurrency');
  // B is busy 9:00-12:00 tomorrow (booking + block); C is free from 9:00.
  // Fade: B $35, C $30. First available must be C at 9:00.
  const groups = groupServices(r.body.members);
  const fade = groups.find((g) => g.key === 'fade');
  assert(fade && fade.members.length === 3 && fade.fromPrice === 30 && fade.maxPrice === 45, '"Fade" merges across three pros, from $30');
  // Owner A is also free at 9:00 - make A busy so the choice is unambiguous.
  await sql`INSERT INTO calendar_blocks (workspace_id, date, start_min, end_min, label, blocks_bookings) VALUES (${A.ws}, ${T}, 0, 1440, 'Day off', TRUE)`;
  r = await call(shopDataH, { query: { slug: shop.slug } });
  const fa = firstAvailable(groupServices(r.body.members).find((g) => g.key === 'fade'), r.body.members, tomorrow);
  assert(fa && fa.member.businessName === 'Charlie Color' && fa.dateISO === T && fa.slot.start === 540, 'first available is Charlie at 9:00 (Bravo busy, Alpha off)');
  // Six visitors race for exactly that slot through Charlie's own booking page.
  const races = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => call(publicBooking, {
    method: 'POST', query: { slug: fa.member.slug },
    body: { serviceId: fa.service.id, date: T, startMin: 540, endMin: 600, clientName: `Racer ${i}`, clientEmail: `racer${i}-${S}@example.com`, shopSlug: shop.slug },
  })));
  const wins = races.filter((x) => x.statusCode === 201);
  assert(wins.length === 1 && races.filter((x) => x.statusCode === 400).length === 5, 'exactly one of six concurrent bookings wins');
  assert(wins[0].body.booking.viaShop?.slug === shop.slug, 'the winner is marked as booked through the shop');
  const landed = await sql`SELECT workspace_id, shop_id, client_name FROM bookings WHERE workspace_id = ${C.ws} AND date = ${T} AND start_min = 540 AND cancelled_at IS NULL`;
  assert(landed.rows.length === 1 && landed.rows[0].shop_id === shop.id, 'the booking landed in Charlie\'s workspace with the shop recorded, once');
  const strayB = await sql`SELECT COUNT(*)::int AS n FROM bookings WHERE workspace_id = ${B.ws} AND client_name LIKE 'Racer%'`;
  const strayA = await sql`SELECT COUNT(*)::int AS n FROM bookings WHERE workspace_id = ${A.ws} AND client_name LIKE 'Racer%'`;
  assert(strayB.rows[0].n === 0 && strayA.rows[0].n === 0, 'nothing landed in any other workspace');
  r = await call(shopDataH, { query: { slug: shop.slug } });
  const fa2 = firstAvailable(groupServices(r.body.members).find((g) => g.key === 'fade'), r.body.members, tomorrow);
  assert(fa2 && fa2.member.businessName === 'Charlie Color' && fa2.slot.start === 600, 'after the booking, first available moves to 10:00');
  // A made-up shop slug is ignored, never recorded.
  const fake = await call(publicBooking, { method: 'POST', query: { slug: C.slug }, body: { serviceId: cFade, date: T, startMin: 600, endMin: 660, clientName: 'Fake Shop', clientEmail: `fake-${S}@example.com`, shopSlug: 'not-a-shop' } });
  assert(fake.statusCode === 201 && fake.body.booking.viaShop === null, 'unknown shopSlug is ignored');
  // A shop E is not a member of is ignored too.
  const eSvc = await mkService(E.ws, 'Gel set', 40);
  const notMember = await call(publicBooking, { method: 'POST', query: { slug: E.slug }, body: { serviceId: eSvc, date: T, startMin: 600, endMin: 660, clientName: 'Not Member', clientEmail: `nm-${S}@example.com`, shopSlug: shop.slug } });
  assert(notMember.statusCode === 201 && notMember.body.booking.viaShop === null, 'a non-member cannot attribute a booking to the shop');
  await wait(1500);
  const cOwnerMail = mailsTo(C.email).find((m) => /New booking/.test(m.subject) && /Racer/.test(m.html));
  assert(cOwnerMail && /Booked through Main Street Barbers/.test(cOwnerMail.html), 'the pro\'s new-booking email says it came through the shop page');
  // (A business's very first client booking gets the "first booking" push
  // instead of the generic one, so the shop line is checked on the chat
  // thread's system message, which every booking writes.)
  const cThread = await sql`SELECT m.text FROM messages m JOIN message_threads t ON t.id = m.thread_id WHERE t.workspace_id = ${C.ws} AND m.kind = 'booking' AND m.meta->>'bookingId' = ${String(wins[0].body.booking.id)} LIMIT 1`;
  assert(cThread.rows[0] && /Booked through Main Street Barbers/.test(cThread.rows[0].text), 'and so does the booking note in the client thread');
  r = await call(shopById, { user: A, query: { id: shop.id } });
  assert(r.body.members.find((m) => m.businessName === 'Charlie Color').stats.total === 1 && r.body.stats.total === 2, 'owner stats count the shop bookings (counts only)');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[6] reviews');
  for (const [ws, rating, who] of [[B.ws, 5, 'Rev One'], [B.ws, 5, 'Rev Two'], [C.ws, 3, 'Rev Three']]) {
    await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text, status) VALUES (${ws}, ${who}, ${rating}, 'Great', 'visible')`;
  }
  await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text, status) VALUES (${C.ws}, 'Hidden Guy', 1, 'hidden', 'hidden')`;
  r = await call(shopDataH, { query: { slug: shop.slug } });
  assert(r.body.rating.count === 3 && r.body.rating.avg === 4.33, 'shop rating is count-weighted (13/3), hidden reviews excluded');
  assert(shopRating(r.body.members).avg === 4.33, 'the page helper agrees');
  assert(r.body.members.find((m) => m.businessName === 'Charlie Color').reviews.recent.every((x) => x.reviewerName !== 'Hidden Guy'), 'hidden review never shows');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[7] leave, remove, lapsed plan');
  r = await call(listingH, { method: 'DELETE', user: B, query: { id: shop.id } });
  assert(r.statusCode === 200 && r.body.left === true, 'B leaves in one tap');
  r = await call(shopDataH, { query: { slug: shop.slug } });
  assert(!r.body.members.some((m) => m.businessName === 'Bravo Cuts') && !JSON.stringify(r.body).includes('Fades since 2010'), 'B vanished from the page at once, bio and all');
  const leftBell = await sql`SELECT title FROM notifications WHERE user_id = ${A.id} AND type = 'shops' AND title LIKE '%left%'`;
  assert(leftBell.rows.length === 1, 'owner is told B left');
  r = await call(shopsIndex, { user: B });
  assert(r.body.memberships.some((m) => m.shop.id === shop.id && m.member.status === 'left'), 'B sees the shop as left');
  r = await call(shopById, { user: A, query: { id: shop.id } });
  const cRoster = r.body.members.find((m) => m.businessName === 'Charlie Color');
  r = await call(membersH, { method: 'DELETE', user: A, query: { id: shop.id }, body: { memberId: cRoster.id } });
  assert(r.statusCode === 200 && r.body.removed === true, 'owner removes C');
  r = await call(shopDataH, { query: { slug: shop.slug } });
  assert(!r.body.members.some((m) => m.businessName === 'Charlie Color'), 'C vanished from the page');
  const cBell2 = await sql`SELECT title FROM notifications WHERE user_id = ${C.id} AND type = 'shops' AND title LIKE 'You were removed%'`;
  assert(cBell2.rows.length === 1, 'C is told');
  r = await call(membersH, { method: 'DELETE', user: A, query: { id: shop.id }, body: { memberId: ownerRow.id } });
  assert(r.statusCode === 400, 'the owner cannot be removed');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[8] join link');
  r = await call(joinLinkH, { method: 'POST', user: A, query: { id: shop.id } });
  assert(r.statusCode === 200 && /\/shops\/invite\//.test(r.body.link), 'owner mints a join link');
  const link1 = decodeURIComponent(r.body.link.split('/shops/invite/')[1]);
  r = await call(joinLinkH, { method: 'POST', user: A, query: { id: shop.id } });
  const link2 = decodeURIComponent(r.body.link.split('/shops/invite/')[1]);
  r = await call(inviteH, { query: { token: link1 } });
  assert(r.statusCode === 410, 'the old join link died when a new one was made');
  r = await call(inviteH, { query: { token: link2 } });
  assert(r.statusCode === 200 && r.body.kind === 'join' && r.body.email === null, 'join link preview');
  r = await call(inviteH, { method: 'POST', user: D, body: { token: link2, action: 'accept' } });
  assert(r.statusCode === 200 && r.body.joined, 'D joins through the link');
  r = await call(inviteH, { method: 'POST', user: D, body: { token: link2, action: 'accept' } });
  assert(r.statusCode === 200 && r.body.alreadyMember === true, 'joining twice is harmless');
  r = await call(inviteH, { method: 'POST', user: A, body: { token: link2, action: 'accept' } });
  assert(r.statusCode === 400 && r.body.code === 'own_shop', 'the owner cannot join their own page');
  // A helper-only account (no business) cannot join.
  const helperOnly = (await sql`INSERT INTO users (email, password_hash, name, terms_version, terms_accepted_at) VALUES (${`shop-helperonly-${S}@example.com`}, 'x', 'Help Er', '2026-05-05', NOW()) RETURNING id`).rows[0];
  created.users.push(helperOnly.id);
  r = await call(inviteH, { method: 'POST', user: helperOnly, body: { token: link2, action: 'accept' } });
  assert(r.statusCode === 403 && r.body.code === 'no_business', 'an account with no business cannot join');
  r = await call(shopDataH, { query: { slug: shop.slug } });
  assert(r.body.members.some((m) => m.businessName === 'Delta Beards'), 'D is on the page');
  // D's plan lapses: hidden, not removed.
  await sql`UPDATE workspaces SET subscription_status = 'cancelled', subscription_period_end = NOW() - INTERVAL '1 day' WHERE id = ${D.ws}`;
  r = await call(shopDataH, { query: { slug: shop.slug } });
  assert(!r.body.members.some((m) => m.businessName === 'Delta Beards'), 'lapsed plan → hidden from the page');
  const dRow = await sql`SELECT status FROM shop_members WHERE shop_id = ${shop.id} AND workspace_id = ${D.ws}`;
  assert(dRow.rows[0].status === 'active', 'but the membership is kept (not removed)');
  r = await call(shopById, { user: A, query: { id: shop.id } });
  assert(r.body.members.find((m) => m.businessName === 'Delta Beards').planActive === false, 'owner roster shows the plan lapsed');
  // Lapsed D cannot accept a fresh invite.
  r = await call(joinLinkH, { method: 'POST', user: A, query: { id: shop.id } });
  const link3 = decodeURIComponent(r.body.link.split('/shops/invite/')[1]);
  await sql`UPDATE shop_members SET status = 'left' WHERE shop_id = ${shop.id} AND workspace_id = ${D.ws}`;
  r = await call(inviteH, { method: 'POST', user: D, body: { token: link3, action: 'accept' } });
  assert(r.statusCode === 402 && r.body.code === 'plan_required', 'a lapsed business cannot join');
  r = await call(joinLinkH, { method: 'DELETE', user: A, query: { id: shop.id } });
  r = await call(inviteH, { query: { token: link3 } });
  assert(r.statusCode === 410, 'turning the link off kills it');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[9] publish gating');
  r = await call(publishH, { method: 'POST', user: A, query: { id: shop.id }, body: { status: 'draft' } });
  r = await call(shopDataH, { query: { slug: shop.slug } });
  assert(r.statusCode === 404, 'unpublished page → 404');
  r = await call(shopHtmlH, { query: { slug: shop.slug }, headers: { host: 'www.joinivy.ai' } });
  assert(r.statusCode === 404, 'unpublished HTML → 404');
  r = await call(publishH, { method: 'POST', user: B, query: { id: shop.id }, body: { status: 'published' } });
  assert(r.statusCode === 404, 'only the owner publishes');
  r = await call(publishH, { method: 'POST', user: A, query: { id: shop.id }, body: { status: 'published' } });
  await sql`UPDATE workspaces SET subscription_status = 'cancelled', subscription_period_end = NOW() - INTERVAL '1 day' WHERE id = ${A.ws}`;
  r = await call(shopDataH, { query: { slug: shop.slug } });
  assert(r.statusCode === 200 && r.body.archived === true && !r.body.members, 'owner plan lapsed → archived payload, nothing else');
  r = await call(shopHtmlH, { query: { slug: shop.slug }, headers: { host: 'www.joinivy.ai' } });
  assert(r.statusCode === 200 && /noindex/.test(r.headers['x-robots-tag'] || '') && /no longer available/.test(String(r.body)), 'archived HTML is noindex');
  await sql`UPDATE workspaces SET subscription_status = 'active', subscription_period_end = NOW() + INTERVAL '30 days' WHERE id = ${A.ws}`;

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[10] Ivy');
  assert(appCallIsRead('shop', { action: 'get' }) && appToolNeedsApproval('shop', { action: 'invite' }) && appToolNeedsApproval('shop', { action: 'publish' }) && appToolNeedsApproval('shop', { action: 'leave' }), 'get reads; every other action is held');
  const ctxA = { workspaceId: A.ws, userId: A.id, args: { action: 'get' } };
  const read = await APP_HANDLERS.shop(ctxA);
  assert(read.owned.length === 1 && read.owned[0].roster.length >= 3 && read.owned[0].stats.bookingsTotal === 2, 'Ivy reads the owner\'s shops with counts');
  assert(!JSON.stringify(read).includes('Priya'), 'Ivy read has no client data');
  let plan = await planAppAction('shop', { action: 'unpublish', shop_id: shop.id }, { workspaceId: A.ws, userId: A.id });
  assert(/Unpublish the shop page "Main Street Barbers"/.test(plan.summary), 'approval card wording');
  let threw = null;
  try { await planAppAction('shop', { action: 'unpublish', shop_id: shop.id }, { workspaceId: E.ws, userId: E.id }); } catch (e) { threw = e.message; }
  assert(threw === 'Shop page not found', 'another owner cannot plan against this shop');
  threw = null;
  try { await planAppAction('shop', { action: 'invite', shop_id: shop.id, email: 'not-an-email' }, { workspaceId: A.ws, userId: A.id }); } catch (e) { threw = e.message; }
  assert(/email is required/.test(threw), 'bad input refused before a card');
  plan = await planAppAction('shop', { action: 'invite', shop_id: shop.id, email: E.email }, { workspaceId: A.ws, userId: A.id });
  assert(/never shows/.test(plan.summary) && /Nothing appears until they accept/.test(plan.summary), 'invite card repeats the promise');
  const inv = await plan.apply();
  assert(inv.ok && inv.sent && inv.member.status === 'invited', 'approved invite goes out');
  const stillOff = await sql`SELECT status FROM shops WHERE id = ${shop.id}`;
  assert(stillOff.rows[0].status === 'published', 'planning unpublish without approval changed nothing');
  plan = await planAppAction('shop', { action: 'create', name: 'Second Spot', slug: `second-${S}` }, { workspaceId: B.ws, userId: B.id });
  assert(/Create the shop page "Second Spot"/.test(plan.summary) && /draft/.test(plan.summary), 'create card');
  const made = await plan.apply();
  assert(made.ok && made.shop.status === 'draft', 'approved create makes a draft');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[11] server-rendered page, sitemap, config');
  await sql`INSERT INTO reviews (workspace_id, reviewer_name, rating, text, status) VALUES (${A.ws}, 'Alpha Fan', 4, 'Solid', 'visible')`;
  r = await call(shopHtmlH, { query: { slug: shop.slug }, headers: { host: 'www.joinivy.ai' } });
  const html = String(r.body);
  assert(r.statusCode === 200 && /text\/html/.test(r.headers['content-type']), 'HTML 200');
  assert(/<title>Main Street Barbers · Austin<\/title>/.test(html), 'title with city');
  assert(html.includes(`<link rel="canonical" href="https://www.joinivy.ai/shop/${shop.slug}"/>`), 'canonical');
  assert(/<meta property="og:title" content="Main Street Barbers · Austin"\/>/.test(html) && /og:image/.test(html) && /twitter:card/.test(html), 'Open Graph + Twitter');
  assert(/<meta name="description" content="Cuts and color under one roof"\/>/.test(html), 'description from the tagline');
  const lds = [...html.matchAll(/<script type="application\/ld\+json">([^]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&')));
  const lb = lds.find((x) => x['@type'] === 'LocalBusiness');
  assert(lb && lb.name === 'Main Street Barbers' && lb.address?.addressLocality === 'Austin' && Array.isArray(lb.openingHoursSpecification) && lb.openingHoursSpecification.length > 0, 'LocalBusiness JSON-LD with address + hours');
  assert(lb.employee?.some((p) => p['@type'] === 'Person' && p.makesOffer?.length > 0 && p.worksFor?.name), 'members as Person with makesOffer');
  assert(lb.aggregateRating?.reviewCount === 1 && lb.aggregateRating?.ratingValue === '4.0', 'honest aggregateRating (only the members still on the page count)');
  assert(lds.some((x) => x['@type'] === 'BreadcrumbList'), 'BreadcrumbList');
  assert(/<h1>Main Street Barbers<\/h1>/.test(html) && /The team/.test(html) && /Alpha Barbers/.test(html) && /Book with Alpha/.test(html), 'readable hero and team markup');
  assert(!html.includes('Priya') && !html.includes('Dentist') && !html.includes('Bravo Cuts') && !html.includes('Charlie Color'), 'no private data; left/removed members absent');
  assert(/id="root"/.test(html), 'SPA shell mounts on top');
  r = await call(sitemapH, {});
  assert(r.statusCode === 200 && String(r.body).includes(`/shop/${shop.slug}</loc>`) && !String(r.body).includes(`second-${S}`), 'sitemap lists published shops only');
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert(vercel.rewrites.some((x) => x.source === '/shop/:slug' && x.destination === '/api/shop/:slug'), 'vercel.json routes /shop/:slug to the server renderer (like /site/:handle)');
  assert(vercel.rewrites.findIndex((x) => x.source === '/shop/:slug') < vercel.rewrites.findIndex((x) => x.destination === '/index.html'), 'before the SPA catch-all');
  assert(vercel.functions['api/shop/**/*.js']?.includeFiles === 'dist/**', 'the renderer bundles dist/');
  assert(!vercel.rewrites.some((x) => /prerender/.test(x.destination) && /shop/.test(x.source)), 'shops are dynamic, never pre-rendered');
  const robots = fs.readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');
  assert(/Sitemap: https:\/\/www\.joinivy\.ai\/shops-sitemap\.xml/.test(robots) && !/Disallow: \/shop/.test(robots), 'robots lists the shops sitemap and allows /shop/');

  // ───────────────────────────────────────────────────────────────────
  console.log('\n[12] booking page, Discover, notification prefs');
  r = await call(publicBooking, { query: { slug: A.slug } });
  assert(r.statusCode === 200 && r.body.calendar.shops.some((s) => s.slug === shop.slug && s.name === 'Main Street Barbers'), 'the owner\'s booking page says "Part of {Shop}"');
  r = await call(publicBooking, { query: { slug: B.slug } });
  assert(r.body.calendar.shops.length === 0, 'a pro who left is no longer "part of" it');
  r = await call(discoverH, { user: E, query: { q: 'Main Street' } });
  assert(r.statusCode === 200 && Array.isArray(r.body.businesses) && r.body.shops.some((s) => s.slug === shop.slug && s.memberCount >= 1), 'Discover lists the shop (business list untouched)');
  r = await call(discoverH, { user: E, query: { q: 'Fade' } });
  assert(r.body.shops.some((s) => s.slug === shop.slug), 'Discover finds a shop by a member\'s service');
  const { EMAIL_NOTIFY_TYPES, OWNER_ONLY_EMAIL_TYPES, EMAIL_NOTIFY_LABELS } = await import('../api/_lib/notificationPrefs.js');
  const { NOTIFY_TYPES } = await import('../api/_lib/push.js');
  assert(EMAIL_NOTIFY_TYPES.includes('shops') && OWNER_ONLY_EMAIL_TYPES.includes('shops') && EMAIL_NOTIFY_LABELS.shops === 'Shop pages' && NOTIFY_TYPES.includes('shops'), 'the shops notification type exists for email and push, owner only');
  // Muted owner gets no shops email.
  await sql`UPDATE users SET notification_prefs = '{"email_shops": false}'::jsonb WHERE id = ${A.id}`;
  const before = mailsTo(A.email).length;
  await sql`UPDATE shop_members SET status = 'active', joined_at = NOW() WHERE shop_id = ${shop.id} AND workspace_id = ${B.ws}`;
  r = await call(listingH, { method: 'DELETE', user: B, query: { id: shop.id } });
  await wait(300);
  assert(mailsTo(A.email).length === before, 'owner who muted shop emails gets none');
  const text = fs.readFileSync(new URL('../api/_lib/shops.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/features/shops/PublicShop.jsx', import.meta.url), 'utf8') + fs.readFileSync(new URL('../src/features/shops/ShopsPage.jsx', import.meta.url), 'utf8');
  assert(!/[–—]/.test(text) && !/business OS/i.test(text), 'copy has no em/en dashes and never says "business OS"');

  console.log(`\n${pass} passed, ${fail} failed`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(async () => {
    try {
      if (created.users.length) await sql.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [created.users]);
    } catch (e) { console.warn('cleanup failed:', e.message); }
    process.exit(fail ? 1 : 0);
  });
