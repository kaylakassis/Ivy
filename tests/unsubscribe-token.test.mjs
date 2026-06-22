// Unit tests for the unsubscribe-token codec (pure functions, no DB).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/unsubscribe-token.test.mjs

import {
  mintUnsubscribeToken, verifyUnsubscribeToken, unsubscribeUrlFor,
} from '../api/_lib/unsubscribeToken.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

process.env.UNSUBSCRIBE_SECRET = 'test-secret-please-rotate-in-prod-1234567890';

console.log('\n[1] round-trip — user scope');
const t1 = mintUnsubscribeToken({ scope: 'user', id: 'user-abc', type: 'marketing' });
assert(typeof t1 === 'string' && t1.includes('.'), 'mints a dotted token');
const v1 = verifyUnsubscribeToken(t1);
assert(v1?.s === 'user', 'scope round-trips');
assert(v1?.i === 'user-abc', 'id round-trips');
assert(v1?.t === 'marketing', 'type round-trips');
assert(typeof v1?.e === 'number' && v1.e > Math.floor(Date.now() / 1000), 'expiry is in the future');

console.log('\n[2] round-trip — client + clientEmail + newsletter scopes');
const t2 = mintUnsubscribeToken({ scope: 'client', id: 'client-1', type: 'bookings' });
assert(verifyUnsubscribeToken(t2)?.s === 'client', 'client scope');
const t3 = mintUnsubscribeToken({ scope: 'clientEmail', id: 'a@b.com', workspaceId: 'ws-9', type: 'invoices' });
const v3 = verifyUnsubscribeToken(t3);
assert(v3?.s === 'clientEmail' && v3?.w === 'ws-9' && v3?.i === 'a@b.com', 'clientEmail carries workspaceId');
const t4 = mintUnsubscribeToken({ scope: 'newsletter', id: 'n@e.com' });
assert(verifyUnsubscribeToken(t4)?.s === 'newsletter', 'newsletter scope');

console.log('\n[3] tamper rejection');
const tampered = t1.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
assert(verifyUnsubscribeToken(tampered) === null, 'flipped signature byte → rejected');
const [body, sig] = t1.split('.');
const swappedBody = Buffer.from(JSON.stringify({ ...verifyUnsubscribeToken(t1), i: 'evil' })).toString('base64url');
assert(verifyUnsubscribeToken(`${swappedBody}.${sig}`) === null, 'swapped payload, kept sig → rejected');
assert(verifyUnsubscribeToken('') === null, 'empty token → rejected');
assert(verifyUnsubscribeToken('not-a-token') === null, 'no dot → rejected');
assert(verifyUnsubscribeToken(`${body}.`) === null, 'empty sig → rejected');

console.log('\n[4] scope whitelist');
assert(mintUnsubscribeToken({ scope: 'bogus', id: 'x' }) === null, 'unknown scope → null mint');
assert(mintUnsubscribeToken({ scope: 'user' }) === null, 'missing id → null mint');

console.log('\n[5] cross-secret isolation');
process.env.UNSUBSCRIBE_SECRET = 'a-completely-different-secret-key';
assert(verifyUnsubscribeToken(t1) === null, 'token minted under old secret no longer verifies');
process.env.UNSUBSCRIBE_SECRET = 'test-secret-please-rotate-in-prod-1234567890';
assert(verifyUnsubscribeToken(t1)?.s === 'user', 'restoring secret restores verification');

console.log('\n[6] URL helper');
const url = unsubscribeUrlFor({ scope: 'user', id: 'u-1', type: 'marketing' });
assert(typeof url === 'string' && url.includes('/api/unsubscribe?token='), 'URL points at /api/unsubscribe');
assert(unsubscribeUrlFor({ scope: 'bogus', id: 'x' }) === null, 'invalid input → null URL (caller omits header)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
