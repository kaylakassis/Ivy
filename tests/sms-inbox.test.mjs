// Tests for two-way SMS folded into client Messages.
//   • Inbound webhook: verifies the Twilio signature, routes by sender
//     phone to the client's thread, appends a 'client' SMS message, bumps
//     unread. Bad signature → 403.
//   • Outbound: sending with channel='sms' stores meta.channel + texts.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/sms-inbox.test.mjs

import crypto from 'node:crypto';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { appUrl } from '../api/_lib/tokens.js';
import inbound from '../api/webhooks/twilio/sms.js';
import threadHandler from '../api/messages/[id].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function sigFor(token, url, params) {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + (params[k] ?? '');
  return crypto.createHmac('sha1', token).update(data).digest('base64');
}
function webhookRes() {
  return { statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k] = v; }, end(s) { if (s) this.body = s; return this; } };
}
function jsonRes() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; },
    setHeader() {}, end() { return this; } };
}

const createdUsers = [];
async function run() {
  try {
    process.env.THRYVE_TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.THRYVE_TWILIO_AUTH_TOKEN = 'twilio-test-token';
    process.env.THRYVE_TWILIO_FROM_NUMBER = '+15550000000';
    const url = `${appUrl()}/api/webhooks/twilio/sms`;

    const u = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`sms-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
    createdUsers.push(u.rows[0].id);
    const uid = u.rows[0].id;
    const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
    const cli = await sql`INSERT INTO clients (workspace_id, name, email, phone, sms_consent_at, stage)
      VALUES (${wid}, 'Tex', NULL, '(555) 123-4567', NOW(), 'active') RETURNING id`;
    const cid = cli.rows[0].id;

    console.log('\n[inbound] routing + signature');
    const params = { From: '+15551234567', To: '+15550000000', Body: 'hi from my phone', MessageSid: 'SM1' };
    const rawBody = new URLSearchParams(params).toString();

    // Bad signature → 403.
    let r = webhookRes();
    await inbound({ method: 'POST', headers: { 'x-twilio-signature': 'wrong' }, body: rawBody }, r);
    assert(r.statusCode === 403, 'inbound rejects an invalid Twilio signature (403)');

    // Valid signature → routed.
    r = webhookRes();
    await inbound({ method: 'POST', headers: { 'x-twilio-signature': sigFor(process.env.THRYVE_TWILIO_AUTH_TOKEN, url, params) }, body: rawBody }, r);
    assert(r.statusCode === 200 && r.body.includes('<Response>'), 'valid inbound returns 200 TwiML');

    const thr = (await sql`SELECT * FROM message_threads WHERE workspace_id = ${wid} AND client_id = ${cid}`).rows[0];
    assert(!!thr, 'a thread was created/found for the texting client');
    assert(thr.unread_biz === 1, 'unread_biz bumped to 1');
    const msgs = (await sql`SELECT * FROM messages WHERE thread_id = ${thr.id} ORDER BY created_at`).rows;
    const inboundMsg = msgs.find((m) => m.sender === 'client');
    assert(inboundMsg && inboundMsg.text === 'hi from my phone', 'inbound text appended as a client message');
    assert(inboundMsg && inboundMsg.meta?.channel === 'sms', 'inbound message tagged channel=sms (despite phone formatting differences)');

    console.log('\n[outbound] channel=sms stores meta + texts');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 201, json: async () => ({ sid: 'SMx', status: 'queued' }) });
    let or;
    try {
      or = jsonRes();
      await threadHandler({
        method: 'POST', headers: { cookie: `thryve_session=${signSession(uid)}` },
        query: { id: thr.id }, body: { text: 'replying by text', channel: 'sms' },
      }, or);
    } finally { globalThis.fetch = realFetch; }

    assert(or.statusCode === 201, 'owner SMS reply accepted (201)');
    assert(or.body?.smsSent === true, 'reply reports the text was sent');
    const outMsg = (await sql`SELECT * FROM messages WHERE thread_id = ${thr.id} AND sender = 'biz' ORDER BY created_at DESC LIMIT 1`).rows[0];
    assert(outMsg?.meta?.channel === 'sms', 'outbound message stored with channel=sms');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    for (const id of createdUsers) {
      await sql`DELETE FROM workspaces WHERE owner_id = ${id}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${id}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
