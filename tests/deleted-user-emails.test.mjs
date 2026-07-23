// A deleted account must receive NOTHING. Deletion mangles the email to
// user+deleted-<id>@domain, but Gmail-style plus-addressing still
// delivers that to the original inbox - so sendEmail() hard-refuses the
// mangled pattern as a belt-and-braces guarantee on top of the
// query-level deleted_at filters in every owner-facing sender.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/deleted-user-emails.test.mjs
import { sendEmail } from '../api/_lib/email.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

// Track whether anything reaches the network.
const realFetch = globalThis.fetch;
let fetched = 0;
globalThis.fetch = async () => { fetched++; return { ok: true, status: 200, json: async () => ({ id: 'em_1' }), text: async () => '{}' }; };

const run = async () => {
  console.log('\n[1] mangled deleted-account addresses are refused');
  for (const to of [
    'kaylakassismedia+deleted-3ecec1a2-1111-2222-3333-444455556666@gmail.com',
    'user+deleted-abc123@x.com',
    'USER+DELETED-9f@x.com',
  ]) {
    fetched = 0;
    const r = await sendEmail({ to, subject: 'x', html: '<p>x</p>' });
    assert(r && r.ok === false && r.skipped === 'deleted-account-address', `refused ${to}`);
    assert(fetched === 0, 'nothing sent to the network');
  }

  console.log('\n[2] ordinary plus-addressing still delivers');
  fetched = 0;
  const r = await sendEmail({ to: 'user+newsletter@gmail.com', subject: 'x', html: '<p>x</p>' });
  assert(fetched === 1, 'normal +tag address goes through');
  assert(!r?.skipped, 'not skipped');

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
};
run();
