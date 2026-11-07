// Public sign-up forms never undo an earlier unsubscribe.
//
//   [1] newsletter (api/newsletter.js): an unsubscribed address that is
//       submitted again gets the same success answer but stays
//       unsubscribed; a new address is added as before
//   [2] waitlist (api/waitlist/join.js): same, and no fresh confirmation
//       email goes to the unsubscribed address
// (The booking-form SMS STOP case is covered in public-booking-privacy.)
//
// Run: node --import ./tests/bootstrap.mjs ./tests/public-forms-keep-optout.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import newsletterHandler from '../api/newsletter.js';
import waitlistJoin from '../api/waitlist/join.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.resend.com')) {
    try { mails.push(JSON.parse(opts.body)); } catch { /* ignore */ }
    return { ok: true, status: 200, json: async () => ({ id: 'em' }), text: async () => '{}' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
};

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s ?? this.body; return this; },
  };
}
let ipN = Math.floor(Math.random() * 100);
function req(body) {
  ipN++;
  return { method: 'POST', url: '/test', query: {}, body,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000',
      'x-forwarded-for': `198.18.${ipN % 250}.${(ipN * 7) % 250}` } };
}
const S = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const em = (t) => `pfo-${t}-${S}@example.com`;

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] newsletter keeps an unsubscribe');
    const gone = em('nl-gone');
    await sql`INSERT INTO newsletter_subscribers (email, source, unsubscribed_at) VALUES (${gone}, 'test', NOW() - INTERVAL '5 days')`;
    let r = mockRes();
    await newsletterHandler(req({ email: gone.toUpperCase(), source: 'footer' }), r);
    assert(r.statusCode === 200 && r.body?.ok === true, 'same success answer (no info leak)');
    let row = (await sql`SELECT unsubscribed_at FROM newsletter_subscribers WHERE email = ${gone}`).rows[0];
    assert(row.unsubscribed_at !== null, 'still unsubscribed after re-submitting the public form');

    const fresh = em('nl-new');
    const r2 = mockRes();
    await newsletterHandler(req({ email: fresh }), r2);
    assert(r2.statusCode === 200 && JSON.stringify(r2.body) === JSON.stringify(r.body), 'new address gets the identical answer');
    row = (await sql`SELECT unsubscribed_at FROM newsletter_subscribers WHERE email = ${fresh}`).rows[0];
    assert(row && row.unsubscribed_at === null, 'new address is subscribed');

    console.log('\n[2] waitlist keeps an unsubscribe');
    const wl = em('wl-gone');
    await sql`INSERT INTO waitlist_signups (email, name, first_name, last_name, source, unsubscribed_at)
      VALUES (${wl}, 'Wes Gone', 'Wes', 'Gone', 'test', NOW() - INTERVAL '2 days')`;
    const before = mails.length;
    r = mockRes();
    await waitlistJoin(req({ email: wl, firstName: 'Wes', lastName: 'Gone', consent: true }), r);
    assert(r.statusCode === 200 && r.body?.received === true, 'same success answer');
    row = (await sql`SELECT unsubscribed_at FROM waitlist_signups WHERE LOWER(email) = ${wl}`).rows[0];
    assert(row.unsubscribed_at !== null, 'still unsubscribed after re-joining through the public form');
    assert(mails.slice(before).every((m) => ![].concat(m.to).includes(wl)), 'no new email sent to the unsubscribed address');

    const wlNew = em('wl-new');
    const r3 = mockRes();
    await waitlistJoin(req({ email: wlNew, firstName: 'Nia', lastName: 'New', consent: true }), r3);
    assert(r3.statusCode === 200 && JSON.stringify(r3.body) === JSON.stringify(r.body), 'new address gets the identical answer');
    row = (await sql`SELECT unsubscribed_at FROM waitlist_signups WHERE LOWER(email) = ${wlNew}`).rows[0];
    assert(row && row.unsubscribed_at === null, 'new address joins normally');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    globalThis.fetch = realFetch;
    await sql`DELETE FROM newsletter_subscribers WHERE email LIKE ${`pfo-%-${S}@example.com`}`.catch(() => {});
    await sql`DELETE FROM waitlist_signups WHERE email LIKE ${`pfo-%-${S}@example.com`}`.catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
