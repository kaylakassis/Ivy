// The In-App Purchase key reaches us through an env-var form that mangles
// line breaks. Every common paste must still parse.
// Run: node --import ./tests/bootstrap.mjs ./tests/apple-pem.test.mjs
import crypto from 'node:crypto';
import { normalizePem } from '../api/_lib/appStoreServer.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const parses = (v) => { try { return crypto.createPrivateKey(normalizePem(v)).asymmetricKeyType === 'ec'; } catch { return false; } };

assert(parses(pem), 'clean multi-line .p8 parses');
assert(parses(pem.replace(/\n/g, '\\n')), 'literal \\n escapes parse');
assert(parses(`"${pem.replace(/\n/g, '\\n')}"`), 'wrapped in quotes parses');
assert(parses(pem.replace(/\n/g, ' ')), 'line breaks replaced by spaces parse');
assert(parses(pem.replace(/\n/g, '')), 'all lines glued together parse');
assert(parses(pem.replace(/\n/g, '\r\n')), 'Windows line endings parse');
assert(normalizePem('') === '' && normalizePem(undefined) === '', 'empty stays empty');
assert(normalizePem('not a key') === 'not a key', 'non-PEM text is left alone for the parser to reject');
assert(!parses('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'), 'garbage body still fails');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
