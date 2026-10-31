// Security hardening from the trust audit:
//   • A password-reset link works once and dies with its expiry; it never
//     becomes a permanent login. A 2FA account gets the code step, not a
//     session.
//   • The account-recovery link never signs anyone in on a re-use.
//   • Client-mode signup does not claim client records before the email is
//     verified; the public review path matches by email only once verified.
//   • The website builder refuses our own hosts and domains another
//     workspace holds, strips script links from site content, and only
//     keeps https attachment URLs.
//   • A client reschedule keeps the booking's length; a package booking's
//     slots are exactly the service length.
//   • Group and DM rosters shown to clients carry names only.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/security-hardening.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession, hashPassword } from '../api/_lib/auth.js';
import { createToken, findValidToken, consumeToken, KIND_RESET, KIND_RECOVER } from '../api/_lib/tokens.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../api/_lib/legal.js';
import { sanitizeSiteLinks, isSafeHref } from '../api/_lib/siteLinkSafety.js';
import { normalizeCustomDomain, isReservedDomain } from '../api/_lib/customDomains.js';
import { serializeGroupMember } from '../api/_lib/groupChat.js';
import { serializeDmThread } from '../api/_lib/clientDms.js';
import resetHandler from '../api/auth/reset-password.js';
import restoreHandler from '../api/account/restore.js';
import signupHandler from '../api/auth/signup.js';
import reviewsHandler from '../api/businesses/[slug]/reviews.js';
import websiteHandler from '../api/website/index.js';
import verifyDomainHandler from '../api/website/verify-domain.js';
import meBookingHandler from '../api/me/bookings/[id].js';
import packageBookHandler from '../api/me/packages/[id]/book.js';

delete process.env.VERCEL_TOKEN;
delete process.env.VERCEL_PROJECT_ID;

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { const key = k.toLowerCase(); if (key === 'set-cookie') { (this.headers[key] ||= []).push(v); } else this.headers[key] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(c, h) { this.statusCode = c; if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v); },
    json(o) { this.body = o; return this; },
    end(s) { if (s !== undefined) this.body = s; return this; },
  };
}
let ipN = 0;
const req = ({ method = 'POST', body = {}, query = {}, cookie, headers = {} } = {}) => ({
  method, url: '/test', query, body,
  headers: {
    'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
    'x-forwarded-for': `203.0.113.${1 + (ipN++ % 250)}`,
    ...(cookie ? { cookie } : {}), ...headers,
  },
});
const call = async (handler, opts) => { const r = mockRes(); await handler(req(opts), r); return r; };
const sessionCookieSet = (r) => (r.headers['set-cookie'] || []).some((c) => /ivy_session=[^;]{10,}/.test(String(c)));

const S = Date.now();
const userIds = [];
async function mkUser(tag, { verified = true, totp = false } = {}) {
  const r = await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at, totp_enrolled_at)
    VALUES (${`sec-${tag}-${S}@example.com`}, ${await hashPassword('old-password-123')}, ${tag}, ${verified ? new Date() : null}, '2026-05-05', NOW(), ${totp ? new Date() : null})
    RETURNING id, email`;
  userIds.push(r.rows[0].id);
  return r.rows[0];
}
async function mkOwner(tag) {
  const u = await mkUser(tag);
  const w = (await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u.id}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0];
  await sql`INSERT INTO calendar_settings (workspace_id, biz_name, slug, availability)
    VALUES (${w.id}, ${`Biz ${tag}`}, ${`sec-${tag}-${S}`}, ${JSON.stringify({ 1: [{ start: 540, end: 1020 }], 2: [{ start: 540, end: 1020 }], 3: [{ start: 540, end: 1020 }], 4: [{ start: 540, end: 1020 }], 5: [{ start: 540, end: 1020 }] })}::jsonb)`;
  return { ...u, workspaceId: w.id, slug: `sec-${tag}-${S}`, cookie: `ivy_session=${signSession(u.id)}` };
}
// Next Wednesday at least 3 days out (inside the seeded Mon-Fri availability).
function futureWeekday() {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 3);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] password-reset tokens: single use, expiry applies to used tokens, 2FA honoured');
    const u1 = await mkUser('reset');
    const raw = await createToken({ userId: u1.id, kind: KIND_RESET, ttlMinutes: 60 });
    let r = await call(resetHandler, { body: { token: raw, password: 'brand-new-password-1' } });
    assert(r.statusCode === 200 && sessionCookieSet(r), 'first use resets and signs in');
    r = await call(resetHandler, { body: { token: raw, password: 'attacker-password-99' } });
    assert(r.statusCode === 401, 'second use of the same link → 401');
    assert(!sessionCookieSet(r), 'second use issues no session');
    const hashAfter = (await sql`SELECT password_hash FROM users WHERE id = ${u1.id}`).rows[0].password_hash;
    const { verifyPassword } = await import('../api/_lib/auth.js');
    assert(await verifyPassword('brand-new-password-1', hashAfter), 'password unchanged by the replay');
    // Expired + used token is not even recognised.
    const raw2 = await createToken({ userId: u1.id, kind: KIND_RESET, ttlMinutes: 60 });
    const v2 = await findValidToken({ kind: KIND_RESET, raw: raw2 });
    await consumeToken(v2.tokenId);
    await sql`UPDATE auth_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${v2.tokenId}`;
    assert((await findValidToken({ kind: KIND_RESET, raw: raw2 })) === null, 'expired used token → null (not alreadyUsed)');
    assert((await consumeToken(v2.tokenId)) === false, 'consumeToken reports false once already used');
    const u2 = await mkUser('reset-totp', { totp: true });
    const raw3 = await createToken({ userId: u2.id, kind: KIND_RESET, ttlMinutes: 60 });
    r = await call(resetHandler, { body: { token: raw3, password: 'brand-new-password-2' } });
    assert(r.statusCode === 200 && r.body?.mfaRequired === true, '2FA account: reset returns mfaRequired');
    assert(!sessionCookieSet(r), '2FA account: no session cookie from reset');

    console.log('\n[2] account recovery link never doubles as a login');
    const u3 = await mkUser('restore');
    await sql`UPDATE users SET deleted_at = NOW() WHERE id = ${u3.id}`;
    const rec = await createToken({ userId: u3.id, kind: KIND_RECOVER, ttlMinutes: 60 });
    r = await call(restoreHandler, { body: { token: rec } });
    assert(r.statusCode === 200 && r.body?.restored === true && sessionCookieSet(r), 'first use restores and signs in');
    r = await call(restoreHandler, { body: { token: rec } });
    assert(r.statusCode === 200 && r.body?.alreadyRestored === true && r.body?.restored === false, 'reuse → alreadyRestored, restored:false');
    assert(!sessionCookieSet(r) && !r.body?.token, 'reuse issues no session');
    const u4 = await mkUser('restore-live');
    const rec2 = await createToken({ userId: u4.id, kind: KIND_RECOVER, ttlMinutes: 60 });
    r = await call(restoreHandler, { body: { token: rec2 } });
    assert(r.statusCode === 200 && !sessionCookieSet(r), 'unused link on a live (never deleted) account issues no session');

    console.log('\n[3] client-mode signup cannot claim a stranger\'s client records');
    const owner = await mkOwner('owner');
    const victimEmail = `sec-victim-${S}@example.com`;
    const victimClient = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${owner.workspaceId}, 'Victim', ${victimEmail}, 'active') RETURNING id`).rows[0];
    r = await call(signupHandler, { body: { mode: 'client', email: victimEmail, password: 'attacker-pass-1234', name: 'Mallory', acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION } });
    assert(r.statusCode === 200 || r.statusCode === 201, `client signup accepted (${r.statusCode})`);
    const attackerId = r.body?.user?.id;
    if (attackerId) userIds.push(attackerId);
    const claimed = (await sql`SELECT user_id FROM clients WHERE id = ${victimClient.id}`).rows[0];
    assert(claimed.user_id === null, 'client row is NOT linked to the unverified signup');

    console.log('\n[4] public reviews: email match needs a verified address');
    await sql`INSERT INTO bookings (workspace_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${owner.workspaceId}, ${victimClient.id}, 'Victim', ${victimEmail}, CURRENT_DATE - 2, 600, 660)`;
    const attackerCookie = attackerId ? `ivy_session=${signSession(attackerId)}` : null;
    if (attackerCookie) {
      r = await call(reviewsHandler, { method: 'POST', cookie: attackerCookie, query: { slug: owner.slug }, body: { rating: 1, text: 'Terrible, from the victim supposedly' } });
      assert(r.statusCode === 400, `unverified account cannot review as the victim (${r.statusCode})`);
      await sql`UPDATE users SET email_verified_at = NOW() WHERE id = ${attackerId}`;
      r = await call(reviewsHandler, { method: 'POST', cookie: attackerCookie, query: { slug: owner.slug }, body: { rating: 5, text: 'Great once verified' } });
      assert(r.statusCode === 200 || r.statusCode === 201, `verified owner of the address can review (${r.statusCode})`);
    }

    console.log('\n[5] custom domains: never ours, never another workspace\'s');
    assert(normalizeCustomDomain('https://WWW.Example.com/') === 'www.example.com', 'normalises scheme/case/slash');
    assert(normalizeCustomDomain('not a domain') === null && normalizeCustomDomain('localhost') === null && normalizeCustomDomain('1.2.3.4') === null, 'rejects junk, single labels, IPs');
    assert(isReservedDomain('www.joinivy.ai') && isReservedDomain('api.joinivy.ai') && isReservedDomain('x.vercel.app'), 'platform hosts reserved');
    assert(!isReservedDomain('rivers-studio.com'), 'ordinary domain not reserved');
    const other = await mkOwner('other');
    const theirs = `held-${S}.example.com`;
    await sql`INSERT INTO websites (workspace_id, handle, business_name, template, sections, pages, visibility, custom_domain, domain_status)
      VALUES (${other.workspaceId}, ${`held${S}`}, 'Other', 'clean', '[]'::jsonb, '[]'::jsonb, 'public', ${theirs}, 'verified')`;
    await sql`INSERT INTO websites (workspace_id, handle, business_name, template, sections, pages, visibility)
      VALUES (${owner.workspaceId}, ${`own${S}`}, 'Own', 'clean', '[]'::jsonb, '[]'::jsonb, 'public')`;
    const put = (body) => call(websiteHandler, { method: 'PUT', cookie: owner.cookie, body });
    r = await put({ customDomain: 'www.joinivy.ai' });
    assert(r.statusCode === 400, 'PUT our own host → 400');
    r = await put({ customDomain: theirs });
    assert(r.statusCode === 400, 'PUT a domain another workspace holds → 400');
    r = await put({ customDomain: 'javascript:alert(1)' });
    assert(r.statusCode === 400, 'PUT a non-domain → 400');
    r = await put({ customDomain: `Mine-${S}.example.com` });
    assert(r.statusCode === 200, 'PUT a legitimate domain → 200');
    const saved = (await sql`SELECT custom_domain FROM websites WHERE workspace_id = ${owner.workspaceId}`).rows[0];
    assert(saved.custom_domain === `mine-${S}.example.com`, 'stored lower-cased');
    // The database refuses a duplicate even if the handler check were bypassed.
    let dup = null;
    try { await sql`UPDATE websites SET custom_domain = ${theirs} WHERE workspace_id = ${owner.workspaceId}`; } catch (e) { dup = e; }
    assert(dup && /idx_websites_custom_domain_unique/.test(dup.message), 'unique index blocks a duplicate domain at the database');
    // verify-domain refuses a reserved host even before DNS.
    await sql`UPDATE websites SET custom_domain = 'www.joinivy.ai' WHERE workspace_id = ${owner.workspaceId}`;
    r = await call(verifyDomainHandler, { method: 'POST', cookie: owner.cookie });
    assert(r.statusCode === 400 && /cannot be connected/i.test(r.body?.error || ''), 'verify-domain refuses a reserved host');
    await sql`UPDATE websites SET custom_domain = NULL WHERE workspace_id = ${owner.workspaceId}`;

    console.log('\n[6] site content: script links are stripped, attachments must be https');
    assert(isSafeHref('https://x.com') && isSafeHref('mailto:a@b.co') && isSafeHref('#book') && isSafeHref('/about') && isSafeHref(''), 'safe schemes pass');
    assert(!isSafeHref('javascript:alert(1)') && !isSafeHref('JAVASCRIPT:x') && !isSafeHref('data:text/html,x') && !isSafeHref('//evil.com'), 'script, data and protocol-relative links fail');
    const clean = sanitizeSiteLinks([{ type: 'hero', ctaLink: 'javascript:alert(1)', items: [{ url: 'vbscript:x', label: 'ok' }], nested: { href: 'https://fine.com' } }]);
    assert(clean[0].ctaLink === '#' && clean[0].items[0].url === '#' && clean[0].nested.href === 'https://fine.com', 'deep sanitiser rewrites only unsafe links');
    r = await put({ sections: [{ id: 's1', type: 'cta', ctaLink: 'javascript:alert(document.cookie)' }] });
    const secs = (await sql`SELECT sections FROM websites WHERE workspace_id = ${owner.workspaceId}`).rows[0].sections;
    assert(r.statusCode === 200 && secs[0].ctaLink === '#', 'PUT stores a sanitised link');

    console.log('\n[7] client reschedule keeps the session length; package slots match the service');
    const svc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price) VALUES (${owner.workspaceId}, 'Hour', 60, 100) RETURNING id`).rows[0];
    const clientUser = await mkUser('client');
    const cl = (await sql`INSERT INTO clients (workspace_id, name, email, stage, user_id) VALUES (${owner.workspaceId}, 'Client', ${clientUser.email}, 'active', ${clientUser.id}) RETURNING id`).rows[0];
    const day = futureWeekday();
    const bk = (await sql`INSERT INTO bookings (workspace_id, service_id, client_id, client_name, client_email, date, start_min, end_min)
      VALUES (${owner.workspaceId}, ${svc.id}, ${cl.id}, 'Client', ${clientUser.email}, ${day}, 600, 660) RETURNING id`).rows[0];
    const clientCookie = `ivy_session=${signSession(clientUser.id)}`;
    r = await call(meBookingHandler, { method: 'PATCH', cookie: clientCookie, query: { id: bk.id }, body: { rescheduleTo: { date: day, startMin: 540, endMin: 1020 } } });
    assert(r.statusCode === 400, 'reschedule with a stretched endMin → 400');
    r = await call(meBookingHandler, { method: 'PATCH', cookie: clientCookie, query: { id: bk.id }, body: { rescheduleTo: { date: day, startMin: 720 } } });
    const moved = (await sql`SELECT start_min, end_min FROM bookings WHERE id = ${bk.id}`).rows[0];
    assert(r.statusCode === 200 && moved.start_min === 720 && moved.end_min === 780, `reschedule derives the end from the booking length (${r.statusCode} ${moved.start_min}-${moved.end_min})`);
    const cp = (await sql`INSERT INTO client_packages (workspace_id, client_id, name, credits_total, credits_remaining, status)
      VALUES (${owner.workspaceId}, ${cl.id}, 'Five pack', 5, 5, 'active') RETURNING id`).rows[0].id;
    r = await call(packageBookHandler, { method: 'POST', cookie: clientCookie, query: { id: cp }, body: { serviceId: svc.id, slots: [{ date: day, startMin: 840, endMin: 1020 }] } });
    assert(r.statusCode === 400 && /60 minutes/.test(r.body?.error || ''), `package slot longer than the service → 400 (${r.statusCode})`);

    console.log('\n[8] client-facing rosters carry names only');
    const gm = serializeGroupMember({ client_id: 'c', client_name: 'Jane', client_email: 'jane@x.com', joined_at: null });
    assert(gm.clientEmail === null, 'group member for clients has no email');
    assert(serializeGroupMember({ client_id: 'c', client_email: 'jane@x.com' }, { forOwner: true }).clientEmail === 'jane@x.com', 'owner view keeps the email');
    const dm = serializeDmThread({ id: 't', client_a_id: 'me', client_b_id: 'them', other_name: 'Sam', other_email: 'sam@x.com' }, 'me');
    assert(dm.otherClientEmail === null && dm.otherClientName === 'Sam', 'DM thread has the other name, never the email');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    try {
      const ids = userIds;
      if (ids.length) {
        await sql`DELETE FROM workspaces WHERE owner_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
      }
      await sql`DELETE FROM users WHERE email LIKE ${`sec-%-${S}@example.com`}`;
    } catch (e) { console.error('cleanup failed:', e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
