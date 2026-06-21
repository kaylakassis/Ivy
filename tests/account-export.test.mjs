// Account data export: the shared buildAccountExport() payload builder
// (used by both the streamed download and the emailed copy). Confirms it
// gathers the owner's data and never leaks a sensitive/credential column.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/account-export.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { buildAccountExport, exportFilename } from '../api/_lib/accountExport.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

let ownerId, workspaceId;
const EMAIL = `export-${Date.now()}@example.com`;

async function run() {
  try {
    await ensureSchemaApplied();
    await sql`DELETE FROM users WHERE email = ${EMAIL}`;
    ownerId = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
      VALUES (${EMAIL}, 'super-secret-bcrypt-hash', 'Export Owner', NOW()) RETURNING id`).rows[0].id;
    workspaceId = (await sql`INSERT INTO workspaces (owner_id) VALUES (${ownerId}) RETURNING id`).rows[0].id;
    await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${workspaceId}, 'A Client', 'c@example.com', 'active')`;
    // finance_settings may carry an encrypted stripe secret - it MUST be stripped.
    await sql`INSERT INTO finance_settings (workspace_id, currency) VALUES (${workspaceId}, 'USD')`.catch(() => {});
    await sql`UPDATE finance_settings SET stripe_secret_encrypted = 'enc::LIVE-SECRET' WHERE workspace_id = ${workspaceId}`.catch(() => {});

    const payload = await buildAccountExport({ id: ownerId, email: EMAIL });

    console.log('\n[1] payload shape');
    assert(payload.ivy_export_version === 1, 'has version');
    assert(typeof payload.exported_at === 'string', 'has exported_at timestamp');
    assert(payload.user?.email === EMAIL, 'includes the owner profile');
    assert(Array.isArray(payload.clients) && payload.clients.some((c) => c.email === 'c@example.com'), 'includes workspace clients');
    assert(Array.isArray(payload.invoices), 'invoices is an array (even if empty)');

    console.log('\n[2] sensitive columns are stripped');
    assert(!('password_hash' in (payload.user || {})), 'user has no password_hash');
    const json = JSON.stringify(payload);
    assert(!json.includes('super-secret-bcrypt-hash'), 'password hash value absent from export');
    assert(!json.includes('LIVE-SECRET'), 'encrypted stripe secret absent from export');
    assert(!json.includes('stripe_secret_encrypted'), 'sensitive key name absent from export');

    console.log('\n[3] filename helper');
    assert(/^ivy-export-\d{4}-\d{2}-\d{2}\.json$/.test(exportFilename()), 'filename is dated json');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    if (workspaceId) {
      await sql`DELETE FROM finance_settings WHERE workspace_id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM clients WHERE workspace_id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
      await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
