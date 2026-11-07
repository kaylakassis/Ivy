// Lead instant reply: the payload contact extractor + the per-workspace
// toggle gate. The Resend sandbox blocks the actual send in tests, so for
// the "enabled" path we assert that it got PAST the gate and attempted a
// send (reason is the send error, not 'disabled'/'no-recipient').
//
// Run: node --import ./tests/bootstrap.mjs ./tests/lead-instant-reply.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { extractLeadContact, notifyLeadInstantReply } from '../api/_lib/leadNotify.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

let ownerId, workspaceId;
const EMAIL = `lead-${Date.now()}@example.com`;

async function run() {
  try {
    await ensureSchemaApplied();

    console.log('\n[1] extractLeadContact pulls email + name from varied payloads');
    let c = extractLeadContact({ Name: 'Dana Lee', Email: 'Dana@Example.com', message: 'hi' });
    assert(c.email === 'dana@example.com', 'lowercased email from "Email" key');
    assert(c.name === 'Dana Lee', 'name from "Name" key');

    c = extractLeadContact({ full_name: 'Sam Ray', emailAddress: 'sam@ex.io' });
    assert(c.email === 'sam@ex.io' && c.name === 'Sam Ray', 'full_name + emailAddress keys');

    c = extractLeadContact({ firstName: 'Jo', contact: 'jo@ex.io' });
    assert(c.email === 'jo@ex.io', 'falls back to an email value under a non-email key');
    assert(c.name === 'Jo', 'firstName captured');

    c = extractLeadContact({ message: 'no contact here' });
    assert(c.email === null, 'no email → null');

    // Workspace for the toggle tests.
    await sql`DELETE FROM users WHERE email = ${EMAIL}`;
    ownerId = (await sql`INSERT INTO users (email, password_hash, name) VALUES (${EMAIL}, 'x', 'Lead Owner') RETURNING id`).rows[0].id;
    workspaceId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO calendar_settings (workspace_id, slug, lead_instant_reply_enabled, biz_name)
              VALUES (${workspaceId}, ${`lead-${Date.now()}`}, TRUE, ${"Kayla's Hair & Nails"})
              ON CONFLICT (workspace_id) DO UPDATE SET lead_instant_reply_enabled = TRUE, biz_name = EXCLUDED.biz_name`;

    console.log('\n[2] no recipient → not sent');
    let r = await notifyLeadInstantReply({ workspaceId, toEmail: '', leadName: 'X' });
    assert(r.sent === false && r.reason === 'no-recipient', 'missing email short-circuits');

    console.log('\n[3] enabled workspace → passes the gate and attempts a send');
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('api.resend.com')) {
        sent.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ id: 'em_test' }), text: async () => '{}' };
      }
      return realFetch(url, opts);
    };
    try {
      r = await notifyLeadInstantReply({ workspaceId, toEmail: 'prospect@example.com', leadName: 'Pat Prospect' });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert(r.reason !== 'disabled' && r.reason !== 'no-recipient', 'got past the toggle gate (attempted send)');

    console.log("\n[3b] default reply shows the business name once-escaped (Kayla's Hair & Nails)");
    const mail = sent[0];
    assert(!!mail, 'reply email was sent');
    assert(mail && mail.html.includes('Kayla&#39;s Hair &amp; Nails will personally get back'), 'name escaped exactly once in the body');
    assert(mail && !/&amp;amp;|&amp;#39;/.test(mail.html), 'no double-escaped entities in the html');
    assert(mail && mail.text.includes("Kayla's Hair & Nails will personally get back"), 'plain-text part reads naturally');

    console.log('\n[4] disabled workspace → skipped before sending');
    await sql`UPDATE calendar_settings SET lead_instant_reply_enabled = FALSE WHERE workspace_id = ${workspaceId}`;
    r = await notifyLeadInstantReply({ workspaceId, toEmail: 'prospect@example.com', leadName: 'Pat' });
    assert(r.sent === false && r.reason === 'disabled', 'disabled toggle prevents the send');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    if (workspaceId) {
      await sql`DELETE FROM calendar_settings WHERE workspace_id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
