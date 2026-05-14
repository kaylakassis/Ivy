// Quick test that the existing /tmp/smoke-onboarding.mjs handlers all
// resolve and the first auth.signup call succeeds locally.
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
await ensureSchemaApplied();
await sql.query("DELETE FROM users WHERE email LIKE 'runner-%@test.local'");

const HEADERS = { origin: 'http://localhost:3001', host: 'localhost:3001', 'user-agent': 'runner/1.0' };
let cookie = '';
function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(code, h) { this.statusCode = code; if (h) for (const [k,v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; },
    json(o) { this.body = o; return this; }, end(s) { this.body = s; return this; },
  };
}
async function call(modPath, opts = {}) {
  const { default: handler } = await import(modPath);
  const req = {
    method: opts.method || 'GET',
    url: opts.url || '/',
    headers: { ...HEADERS, cookie, 'content-type': 'application/json' },
    query: opts.query || {}, body: opts.body, on() {},
  };
  const res = makeRes();
  await handler(req, res);
  const sc = res.headers['set-cookie'];
  if (sc) {
    const arr = Array.isArray(sc) ? sc : [sc];
    for (const c of arr) {
      const m = c.match(/^(thryve_session)=([^;]+)/);
      if (m) cookie = `${m[1]}=${m[2]}`;
    }
  }
  return { status: res.statusCode, body: res.body };
}

const { CURRENT_TERMS_VERSION } = await import('../src/lib/legal.js');
const email = `runner-${Date.now()}@test.local`;
const r1 = await call('../api/auth/signup.js', {
  method: 'POST',
  body: { email, password: 'password1234', name: 'Runner', mode: 'owner', acceptedTermsVersion: CURRENT_TERMS_VERSION },
});
console.log('signup:', r1.status, JSON.stringify(r1.body).slice(0, 120));

const r2 = await call('../api/auth/me.js');
console.log('me:', r2.status, JSON.stringify(r2.body).slice(0, 120));

const r3 = await call('../api/calendar/index.js', {
  method: 'PATCH',
  body: { bizName: 'Runner Studio', slug: 'runner-' + Date.now().toString(36) },
});
console.log('calendar PATCH:', r3.status, JSON.stringify(r3.body).slice(0, 120));

const r4 = await call('../api/me/notifications.js');
console.log('notifications GET:', r4.status, 'has emailPrefs:', !!r4.body?.emailPrefs);

const r5 = await call('../api/me/notifications.js', {
  method: 'PATCH',
  body: { emailPrefs: { bookings: false } },
});
console.log('notifications PATCH:', r5.status, 'bookings=', r5.body?.emailPrefs?.bookings);

// Verify the new column landed.
const { rows } = await sql`SELECT notification_prefs FROM users WHERE email = ${email}`;
console.log('stored email_bookings:', rows[0]?.notification_prefs?.email_bookings);

process.exit(0);
