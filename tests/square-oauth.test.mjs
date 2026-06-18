// Square OAuth URL contract - the redirect_uri must be stable, pinnable,
// and identical between the authorize step and the token exchange, and the
// authorize host must follow the environment. These are the pieces that
// break "connect Square" when misconfigured.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/square-oauth.test.mjs

import { squareRedirectUri, buildAuthorizeUrl, squareEnv } from '../api/_lib/payments/square.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Clean slate for the env we toggle.
delete process.env.SQUARE_REDIRECT_URI;
delete process.env.SQUARE_ENVIRONMENT;
process.env.SQUARE_APPLICATION_ID = 'sq0idp-test';

console.log('\n[1] squareRedirectUri');
const def = squareRedirectUri();
assert(def.endsWith('/api/finance/square-oauth-callback'), 'default points at the callback route');
assert(!def.includes('//api'), 'no double slash in default redirect uri');

process.env.SQUARE_REDIRECT_URI = 'https://app.example.com/api/finance/square-oauth-callback/';
assert(squareRedirectUri() === 'https://app.example.com/api/finance/square-oauth-callback',
  'explicit SQUARE_REDIRECT_URI wins and trailing slash is stripped');
delete process.env.SQUARE_REDIRECT_URI;

console.log('\n[2] authorize URL is well-formed (sandbox default)');
const sandboxUrl = buildAuthorizeUrl({ state: 'STATE123', redirectUri: squareRedirectUri() });
const su = new URL(sandboxUrl);
assert(squareEnv() === 'sandbox', 'defaults to sandbox env');
assert(su.host === 'connect.squareupsandbox.com', 'sandbox uses squareupsandbox host');
assert(su.pathname === '/oauth2/authorize', 'hits /oauth2/authorize');
assert(su.searchParams.get('client_id') === 'sq0idp-test', 'client_id from SQUARE_APPLICATION_ID');
assert(su.searchParams.get('state') === 'STATE123', 'state echoed');
assert(su.searchParams.get('redirect_uri') === squareRedirectUri(), 'redirect_uri matches the helper exactly');
assert((su.searchParams.get('scope') || '').includes('PAYMENTS_WRITE'), 'scopes present');

console.log('\n[3] authorize host follows SQUARE_ENVIRONMENT=production');
process.env.SQUARE_ENVIRONMENT = 'production';
const prodUrl = new URL(buildAuthorizeUrl({ state: 's', redirectUri: 'https://x/cb' }));
assert(squareEnv() === 'production', 'reads production env');
assert(prodUrl.host === 'connect.squareup.com', 'production uses squareup host (NOT sandbox)');
delete process.env.SQUARE_ENVIRONMENT;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
