// Public booking endpoint for the 1.0.5 page, against a real database.
//   • GET keeps every field the old page (iPhone app 1.0.4) reads; only adds
//     contactPhone, which is just the phone from the owner's invoice contact
//     block (never the rest of it).
//   • Cross-workspace: one business's page never carries another's bookings,
//     clients or services; a deep link / booking with another workspace's
//     service id goes nowhere.
//   • POST confirmation carries add-to-calendar links incl. the new Outlook one.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/public-booking-page.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import slugHandler from '../api/calendar/public/[slug].js';
import { resolveServiceParam, listedServices } from '../src/features/calendar/publicBookingHelpers.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Swallow outbound mail (confirmation / claim invites).
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'em' }), text: async () => '{}' });

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { if (s !== undefined) { try { this.body = JSON.parse(s); } catch { this.body = s; } } return this; },
  };
}
const STAMP = Date.now();
let ipN = Math.floor(Math.random() * 200);
function req({ method = 'GET', body = {}, query = {} } = {}) {
  ipN++;
  return { method, url: '/test', query, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.51.100.${(ipN % 200) + 20}` } };
}
const call = async (o) => { const r = mockRes(); await slugHandler(req(o), r); return r; };
const em = (t) => `pbpage-${t}-${STAMP}@example.com`;
const fullWeek = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: 0, end: 1440 }]]));
const iso = (d) => d.toISOString().slice(0, 10);
const users = [];
const workspaces = [];

// Fields the 1.0.4 page reads. Must never disappear.
const LEGACY_CAL = ['giftCardsAvailable', 'settings', 'services', 'blocks', 'bookings', 'reviews', 'memberships', 'packages', 'programs', 'businessType', 'websiteHandle'];
const LEGACY_SETTINGS = ['bizName', 'slug', 'slotMinutes', 'slotFitService', 'bufferMinutes', 'minNoticeHours', 'maxAdvanceDays', 'availability',
  'discoverable', 'tagline', 'category', 'timezone', 'brandLogoUrl', 'brandAccentColor', 'addressLabel', 'lat', 'lng'];
const LEGACY_SERVICE = ['id', 'name', 'durationMinutes', 'price', 'description', 'photoUrl', 'prepInstructions', 'capacity', 'depositType',
  'depositAmount', 'locationType', 'locationLabel', 'visibility', 'travelBufferMinutes', 'cancellationFeeAmount', 'cancellationWindowHours',
  'noShowFeeAmount', 'customFields', 'addOns', 'availability'];

async function makeBiz(tag, { contact = null } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${em(tag + '-owner')}, 'x', 'Owner', NOW()) RETURNING id`).rows[0].id;
  users.push(u);
  const w = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, ${'WS ' + tag}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  workspaces.push(w);
  const slug = `pbpage-${tag}-${STAMP}`;
  await sql.query(
    `INSERT INTO calendar_settings (workspace_id, biz_name, slug, timezone, slot_minutes, min_notice_hours, availability, biz_contact)
     VALUES ($1, $2, $3, 'America/New_York', 30, 0, $4::jsonb, $5)
     ON CONFLICT (workspace_id) DO UPDATE SET biz_name = $2, slug = $3, timezone = 'America/New_York', slot_minutes = 30,
       min_notice_hours = 0, availability = $4::jsonb, biz_contact = $5`,
    [w, 'Biz ' + tag, slug, JSON.stringify(fullWeek), contact],
  );
  return { u, w, slug };
}

async function run() {
  await ensureSchemaApplied();
  const A = await makeBiz('a', { contact: '9 Secret Street\nSpringfield 11211\n(718) 555-0142 · owner-private@example.com' });
  const B = await makeBiz('b');
  const svcA = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price, photo_url, description)
    VALUES (${A.w}, 'Silk Press', 60, 95, 'https://example.com/silk.jpg', 'Glossy finish') RETURNING id`).rows[0].id;
  const privA = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price, visibility)
    VALUES (${A.w}, 'VIP Bridal Trial', 60, 220, 'private') RETURNING id`).rows[0].id;
  const draftA = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price, visibility)
    VALUES (${A.w}, 'Draft Thing', 60, 10, 'only_me') RETURNING id`).rows[0].id;
  const svcB = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price)
    VALUES (${B.w}, 'Silk Press', 60, 80) RETURNING id`).rows[0].id;
  const clB = (await sql`INSERT INTO clients (workspace_id, name, email, phone, stage)
    VALUES (${B.w}, 'Bea Bclient', ${em('bea')}, '+15555550111', 'active') RETURNING id`).rows[0].id;
  const bookB = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min, notes)
    VALUES (${B.w}, ${svcB}, ${clB}, 'Bea Bclient', ${em('bea')}, CURRENT_DATE + 2, 600, 660, 'b-private-note') RETURNING id`).rows[0].id;
  const bookA = (await sql`INSERT INTO bookings (workspace_id, service_id, client_name, client_email, date, start_min, end_min, notes)
    VALUES (${A.w}, ${svcA}, 'Ada Aclient', ${em('ada')}, CURRENT_DATE + 2, 600, 660, 'a-private-note') RETURNING id`).rows[0].id;

  console.log('\n[1] GET keeps every legacy field and only adds');
  let r = await call({ query: { slug: A.slug } });
  assert(r.statusCode === 200, `GET 200 (${r.statusCode})`);
  const cal = r.body?.calendar || {};
  assert(LEGACY_CAL.every((k) => k in cal), `calendar still has ${LEGACY_CAL.join(', ')}`);
  assert(LEGACY_SETTINGS.every((k) => k in (cal.settings || {})), 'settings keep every field the old page reads');
  const sA = (cal.services || []).find((s) => s.id === svcA);
  assert(sA && LEGACY_SERVICE.every((k) => k in sA), 'services keep every field the old page reads');
  assert(sA?.photoUrl === 'https://example.com/silk.jpg' && sA?.description === 'Glossy finish', 'service photo + description served');
  assert(Array.isArray(cal.reviews?.recent) && typeof cal.reviews?.count === 'number', 'reviews summary shape unchanged');

  console.log('\n[2] contactPhone: only the phone, only for this business');
  assert(cal.contactPhone === '(718) 555-0142', `contactPhone from the invoice contact block (${cal.contactPhone})`);
  const raw = JSON.stringify(r.body);
  assert(!raw.includes('owner-private@example.com') && !raw.includes('9 Secret Street'), 'the rest of the contact block is never served');
  r = await call({ query: { slug: B.slug } });
  assert(r.statusCode === 200 && r.body.calendar.contactPhone === null, 'no contact block = contactPhone null');

  console.log('\n[3] cross-workspace isolation');
  r = await call({ query: { slug: A.slug } });
  const rawA = JSON.stringify(r.body);
  const ids = (r.body.calendar.bookings || []).map((b) => b.id);
  assert(ids.includes(bookA) && !ids.includes(bookB), "A's page lists A's booking, not B's");
  for (const leak of [bookB, svcB, clB, 'Bea Bclient', em('bea'), 'b-private-note', 'Ada Aclient', em('ada'), 'a-private-note']) {
    assert(!rawA.includes(leak), `"${String(leak).slice(0, 18)}" not in A's payload`);
  }
  const svcIds = r.body.calendar.services.map((s) => s.id);
  assert(svcIds.includes(privA) && !svcIds.includes(draftA), "private services still served for the old page and direct links; 'only me' drafts never");
  assert(listedServices(r.body.calendar.services).every((s) => s.id !== privA), 'new page hides private services from its list');

  console.log('\n[4] deep links resolve only within this business');
  const svcs = r.body.calendar.services;
  assert(resolveServiceParam(svcs, svcA)?.id === svcA, 'own service by id');
  assert(resolveServiceParam(svcs, 'silk-press')?.id === svcA, "own service by name slug (B's same-named service never wins)");
  assert(resolveServiceParam(svcs, 'vip-bridal-trial')?.id === privA, 'private service by direct link');
  assert(resolveServiceParam(svcs, svcB) === null, "another workspace's service id resolves to nothing");
  assert(resolveServiceParam(svcs, draftA) === null, "an 'only me' draft cannot be deep linked");
  const day = iso(new Date(Date.now() + 5 * 86400e3));
  r = await call({ method: 'POST', query: { slug: A.slug }, body: {
    serviceId: svcB, date: day, startMin: 600, endMin: 660, clientName: 'Cross Over', clientEmail: em('cross'),
  } });
  assert(r.statusCode === 400 && /unknown service/i.test(r.body?.error || ''), `booking B's service through A's page is refused (${r.statusCode})`);

  console.log('\n[5] confirmation carries Google, .ics and Outlook links');
  r = await call({ method: 'POST', query: { slug: A.slug }, body: {
    serviceId: svcA, date: day, startMin: 600, endMin: 660, clientName: 'Nia New', clientEmail: em('nia'),
  } });
  assert(r.statusCode === 201, `booking created (${r.statusCode}: ${r.body?.error || 'ok'})`);
  const links = r.body?.booking?.calendar || {};
  assert(/^https:\/\/calendar\.google\.com\//.test(links.google || ''), 'google link (unchanged)');
  assert(/\/api\/calendar\/invite\?b=/.test(links.ics || ''), 'ics link (unchanged)');
  const o = links.outlook ? new URL(links.outlook) : null;
  assert(o && o.hostname === 'outlook.live.com', 'outlook link added');
  assert(o && /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(o.searchParams.get('startdt') || ''), `outlook start is an absolute instant (${o?.searchParams.get('startdt')})`);
  const bk = r.body?.booking || {};
  assert(['id', 'date', 'startMin', 'endMin', 'videoRoomUrl', 'bookingTotal', 'locationType', 'depositRequired', 'calendar'].every((k) => k in bk), 'booking response keeps its fields');
  assert(!JSON.stringify(r.body).includes(em('ada')), "confirmation never carries another client's details");

  console.log('\n[6] private service bookable by direct link');
  r = await call({ method: 'POST', query: { slug: A.slug }, body: {
    serviceId: privA, date: day, startMin: 720, endMin: 780, clientName: 'Vee Vip', clientEmail: em('vee'),
  } });
  assert(r.statusCode === 201, `private service books (${r.statusCode}: ${r.body?.error || 'ok'})`);
}

async function cleanup() {
  try {
    for (const w of workspaces) await sql`DELETE FROM workspaces WHERE id = ${w}`;
    for (const u of users) await sql`DELETE FROM users WHERE id = ${u}`;
  } catch (e) { console.error('cleanup:', e.message); }
}

run()
  .catch((e) => { fail++; console.error(e); })
  .finally(async () => {
    await new Promise((res) => setTimeout(res, 600)); // let fire-and-forget side effects land first
    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
