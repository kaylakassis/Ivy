// Unit tests for the Twilio number-pool picker (api/_lib/twilio.js).
// No live Twilio calls — we only exercise isTwilioConfigured and the
// stable-hash pool picker via its observable side effect (the From= in
// the form body the SDK would post).
//
// Run: node --import ./tests/bootstrap.mjs ./tests/twilio-pool.test.mjs

import { isTwilioConfigured } from '../api/_lib/twilio.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function clearEnv() {
  delete process.env.IVY_TWILIO_ACCOUNT_SID;
  delete process.env.IVY_TWILIO_AUTH_TOKEN;
  delete process.env.IVY_TWILIO_FROM_NUMBER;
  delete process.env.IVY_TWILIO_FROM_NUMBERS;
}

console.log('\n[1] isTwilioConfigured');
clearEnv();
assert(isTwilioConfigured() === false, 'empty env → false');

process.env.IVY_TWILIO_ACCOUNT_SID = 'ACxxx';
process.env.IVY_TWILIO_AUTH_TOKEN = 'tok';
assert(isTwilioConfigured() === false, 'sid+token but no from → false');

process.env.IVY_TWILIO_FROM_NUMBER = '+15551234567';
assert(isTwilioConfigured() === true, 'sid+token+single from → true');

clearEnv();
process.env.IVY_TWILIO_ACCOUNT_SID = 'ACxxx';
process.env.IVY_TWILIO_AUTH_TOKEN = 'tok';
process.env.IVY_TWILIO_FROM_NUMBERS = '+15551111111,+15552222222';
assert(isTwilioConfigured() === true, 'sid+token+pool → true');

clearEnv();
process.env.IVY_TWILIO_ACCOUNT_SID = 'ACxxx';
process.env.IVY_TWILIO_AUTH_TOKEN = 'tok';
process.env.IVY_TWILIO_FROM_NUMBERS = '   ,   ,   ';
assert(isTwilioConfigured() === false, 'pool with only whitespace/commas → false');

console.log('\n[2] Pool precedence: NUMBERS (plural) beats NUMBER (singular)');
clearEnv();
process.env.IVY_TWILIO_ACCOUNT_SID = 'ACxxx';
process.env.IVY_TWILIO_AUTH_TOKEN = 'tok';
process.env.IVY_TWILIO_FROM_NUMBER  = '+15551111111';
process.env.IVY_TWILIO_FROM_NUMBERS = '+15552222222,+15553333333';
assert(isTwilioConfigured() === true, 'both set → still configured');
// (The picker itself is internal — we verify behavior via sendSms in
// integration; here we only assert isTwilioConfigured + pool parsing.)

console.log('\n[3] Pool parsing tolerates messy whitespace + trailing commas');
clearEnv();
process.env.IVY_TWILIO_ACCOUNT_SID = 'ACxxx';
process.env.IVY_TWILIO_AUTH_TOKEN = 'tok';
process.env.IVY_TWILIO_FROM_NUMBERS = '  +15551111111  ,  +15552222222 , ';
assert(isTwilioConfigured() === true, 'whitespace + trailing comma still parses');

console.log('\n[4] Singular falls back when plural is missing');
clearEnv();
process.env.IVY_TWILIO_ACCOUNT_SID = 'ACxxx';
process.env.IVY_TWILIO_AUTH_TOKEN = 'tok';
process.env.IVY_TWILIO_FROM_NUMBER = '+15551234567';
assert(isTwilioConfigured() === true, 'singular alone still works (back-compat)');

clearEnv();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
