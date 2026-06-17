// Tests the consolidated Twilio inbound webhook: it now handles BOTH
// STOP/START compliance keywords AND threads non-keyword replies into the
// client's conversation (previously these were split across two endpoints
// and you could only wire Twilio to one).
//
// Run with:
//   node --import ./tests/bootstrap.mjs ./tests/twilio-inbound.test.mjs

process.env.IVY_TWILIO_AUTH_TOKEN ||= 'test-twilio-token';

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import handler from '../api/webhooks/twilio/sms.js';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const URL = 'http://localhost:5173/api/webhooks/twilio/sms';
function sign(params) {
  const data = Object.keys(params).sort().reduce((d, k) => d + k + (params[k] ?? ''), URL);
  return crypto.createHmac('sha1', process.env.IVY_TWILIO_AUTH_TOKEN).update(data).digest('base64');
}
function mockRes() {
  return { statusCode: 200, body: '', headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s || ''; return this; } };
}
async function inbound(params, { badSig = false } = {}) {
  const raw = new URLSearchParams(params).toString();
  const signature = badSig ? 'nope' : sign(params);
  const res = mockRes();
  await handler({ method: 'POST', body: raw, headers: { 'x-twilio-signature': signature, host: 'localhost:5173' } }, res);
  return res;
}

async function run() {
  await ensureSchemaApplied();
  const tag = `tw-${Date.now()}`;
  const phone = '+15557654321';
  const uid = (await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
    VALUES (${`${tag}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  const cid = (await sql`INSERT INTO clients (workspace_id, name, phone, sms_consent_at)
    VALUES (${wid}, 'Texty Client', ${phone}, NOW()) RETURNING id`).rows[0].id;

  const consent = async () => (await sql`SELECT sms_consent_at FROM clients WHERE id = ${cid}`).rows[0].sms_consent_at;

  console.log('\n[1] signature is enforced');
  let res = await inbound({ From: phone, To: '+15550000000', Body: 'STOP' }, { badSig: true });
  assert(res.statusCode === 403, 'bad signature → 403');
  assert((await consent()) != null, 'consent unchanged on a bad-signature request');

  console.log('\n[2] STOP / START flip consent');
  res = await inbound({ From: phone, To: '+15550000000', Body: 'STOP' });
  assert(res.statusCode === 200, 'STOP acked 200');
  assert((await consent()) == null, 'STOP wiped sms_consent_at');
  await inbound({ From: phone, To: '+15550000000', Body: 'START' });
  assert((await consent()) != null, 'START restored sms_consent_at');

  console.log('\n[3] a normal reply is threaded + flagged unread for the owner');
  await inbound({ From: phone, To: '+15550000000', Body: 'Hey, can I move to 3pm?' });
  const thread = (await sql`SELECT id, unread_biz, last_message_preview FROM message_threads WHERE workspace_id = ${wid} AND client_id = ${cid}`).rows[0];
  assert(!!thread, 'a thread now exists for the client');
  assert(Number(thread.unread_biz) >= 1, 'unread_biz incremented for the owner');
  const msg = (await sql`SELECT text, sender FROM messages WHERE thread_id = ${thread.id} ORDER BY created_at DESC LIMIT 1`).rows[0];
  assert(msg && msg.sender === 'client' && /move to 3pm/.test(msg.text), 'the reply landed in the thread as a client message');

  console.log('\n[4] a keyword reply is NOT threaded');
  const before = (await sql`SELECT COUNT(*)::int n FROM messages WHERE thread_id = ${thread.id}`).rows[0].n;
  await inbound({ From: phone, To: '+15550000000', Body: 'STOP' });
  const after = (await sql`SELECT COUNT(*)::int n FROM messages WHERE thread_id = ${thread.id}`).rows[0].n;
  assert(after === before, 'STOP did not create a message in the thread');

  // Cleanup.
  await sql`DELETE FROM messages WHERE thread_id = ${thread.id}`;
  await sql`DELETE FROM message_threads WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM clients WHERE workspace_id = ${wid}`;
  await sql`DELETE FROM workspaces WHERE id = ${wid}`;
  await sql`DELETE FROM users WHERE id = ${uid}`;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
