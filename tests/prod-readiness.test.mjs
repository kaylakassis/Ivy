// Verifies /api/admin/prod-readiness returns sane structure and
// correctly classifies missing-config as blockers / warnings.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/prod-readiness.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';

// Auth via x-admin-secret - set BEFORE the module loads.
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret-at-least-32-chars-long-please';

const { default: handler } = await import('../api/admin/prod-readiness.js');

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s)  { this.body = s; return this; },
  };
}
function adminReq() {
  return {
    method: 'GET', url: '/api/admin/prod-readiness',
    headers: { 'x-admin-secret': process.env.ADMIN_SECRET },
  };
}

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] auth gate');
    const noAuth = mkRes();
    await handler({ method: 'GET', headers: {} }, noAuth);
    assert(noAuth.statusCode === 401, `no admin secret → 401 (got ${noAuth.statusCode})`);

    console.log('\n[2] returns structured report');
    const r = mkRes();
    await handler(adminReq(), r);
    assert(r.statusCode === 200, `200 (got ${r.statusCode})`);
    assert(Array.isArray(r.body?.checks), 'checks is an array');
    assert(typeof r.body?.blockers === 'number', 'blockers count present');
    assert(typeof r.body?.warnings === 'number', 'warnings count present');
    assert(typeof r.body?.goLive === 'string', 'goLive message present');

    console.log('\n[3] core secrets each have an entry');
    const keys = new Set(r.body.checks.map((c) => c.key));
    for (const required of [
      'jwt_secret', 'admin_secret', 'cron_secret', 'secrets_key', 'app_url',
      'database', 'stripe_key', 'stripe_webhook', 'stripe_price', 'funnel',
      'email', 'email_from',
      'push', 'blob', 'ivy', 'sentry', 'node_env',
    ]) {
      assert(keys.has(required), `${required} check present`);
    }

    console.log('\n[3a] funnel check flags the no-card fallback when Stripe is missing');
    const funnel = r.body.checks.find((c) => c.key === 'funnel');
    if (!process.env.STRIPE_SECRET_KEY || !process.env.IVY_STRIPE_PRICE_ID) {
      assert(funnel.level === 'fail', 'no-card fallback is surfaced as a BLOCKER');
      assert(/no-card|NO-CARD/.test(funnel.detail || ''), 'detail mentions the no-card fallback');
    }

    console.log('\n[4] missing CRON_SECRET marked as fail');
    const cron = r.body.checks.find((c) => c.key === 'cron_secret');
    // In the test env CRON_SECRET is unset → expect 'fail'.
    assert(cron.level === 'fail',
      `cron_secret unset → fail (got '${cron.level}': ${cron.detail || ''})`);

    console.log('\n[5] localhost APP_URL marked as fail');
    process.env.APP_URL = 'http://localhost:5173';
    const r2 = mkRes();
    await handler(adminReq(), r2);
    const url = r2.body.checks.find((c) => c.key === 'app_url');
    assert(url.level === 'fail' && /localhost/i.test(url.detail || ''),
      `localhost APP_URL → fail (got '${url.level}')`);

    console.log('\n[6] https APP_URL marked ok');
    process.env.APP_URL = 'https://getivyos.com';
    const r3 = mkRes();
    await handler(adminReq(), r3);
    const url3 = r3.body.checks.find((c) => c.key === 'app_url');
    assert(url3.level === 'ok', `https APP_URL → ok (got '${url3.level}')`);

    console.log('\n[7] NODE_ENV=development is a warn');
    const nodeEnv = r.body.checks.find((c) => c.key === 'node_env');
    assert(nodeEnv && nodeEnv.level !== 'ok',
      `non-prod NODE_ENV is non-ok (got '${nodeEnv?.level}')`);

    console.log('\n[8] blockers count reflects real failures');
    assert(r.body.blockers > 0, 'test env has at least one blocker (cron_secret)');
    assert(r.body.ok === false, 'ok=false when blockers > 0');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
