// The data export holds every kind of record a business keeps in Ivy.
//   [1] every listed table really exists and is tied to the business
//   [2] a row put into each kind of record comes out in the file
//   [3] nothing from another business comes out with it
//   [4] no secret, and nobody's sign-in number, comes out
//   [5] what the app and the site say about the export is exact
//
// Run: node --import ./tests/bootstrap.mjs ./tests/account-export-complete.test.mjs
import { readFileSync } from 'node:fs';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { buildAccountExport, EXTRA_TABLES, EXPORTED_EXTRA_KEYS } from '../api/_lib/accountExport.js';

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const S = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const made = [];

async function mkBusiness(tag) {
  const email = `exp-${tag}-${S}@example.com`;
  const uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (${email}, 'bcrypt-secret-value', ${`${tag} Owner`}, NOW()) RETURNING id`).rows[0].id;
  const ws = (await sql`INSERT INTO workspaces (owner_id) VALUES (${uid}) RETURNING id`).rows[0].id;
  const client = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${ws}, ${`${tag} Client`}, ${`client-${tag}-${S}@example.com`}, 'active') RETURNING id`).rows[0].id;
  made.push({ uid, ws });
  return { uid, ws, client, email, tag };
}

// One recognisable row in each kind of record. `mark` is a word only this
// business's rows carry, so finding it proves where a row came from.
async function fill(b, mark, otherUserId) {
  const ok = {};
  const put = async (key, fn) => { try { await fn(); ok[key] = true; } catch (e) { ok[key] = e.message; } };
  const { ws, client } = b;
  await put('workspace_profile', () => sql`INSERT INTO workspace_profile (workspace_id, ideal_client) VALUES (${ws}, ${mark + '-profile'})`);
  await put('quotes', () => sql`INSERT INTO quotes (workspace_id, number, client_name, notes, view_token_hash) VALUES (${ws}, ${`Q-${mark}`}, 'Quote Client', ${mark + '-quote'}, ${'HASHLEAK-' + mark})`);
  await put('recurring_invoices', () => sql`INSERT INTO recurring_invoices (workspace_id, name, client_name, cadence, next_run_at) VALUES (${ws}, ${mark + '-recurring'}, 'RC', 'monthly', NOW() + INTERVAL '30 days')`);
  await put('projects', () => sql`INSERT INTO projects (workspace_id, name) VALUES (${ws}, ${mark + '-project'})`);
  await put('products', () => sql`INSERT INTO products (workspace_id, name, price) VALUES (${ws}, ${mark + '-product'}, 12)`);
  await put('packages', () => sql`INSERT INTO packages (workspace_id, name, session_count, price) VALUES (${ws}, ${mark + '-package'}, 5, 200)`);
  await put('memberships', () => sql`INSERT INTO memberships (workspace_id, name, price_cents, interval) VALUES (${ws}, ${mark + '-membership'}, 5000, 'month')`);
  await put('gift_cards', () => sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, sender_name) VALUES (${ws}, ${'CODEHASHLEAK-' + mark}, '1234', 5000, 5000, ${mark + '-giftcard'})`);
  await put('workflows', () => sql`INSERT INTO workflows (workspace_id, name, trigger_type) VALUES (${ws}, ${mark + '-workflow'}, 'booking_completed')`);
  await put('email_campaigns', () => sql`INSERT INTO email_campaigns (workspace_id, subject, body) VALUES (${ws}, ${mark + '-campaign'}, 'Hello')`);
  await put('reviews', () => sql`INSERT INTO reviews (workspace_id, client_id, reviewer_user_id, reviewer_name, rating, text) VALUES (${ws}, ${client}, ${otherUserId}, 'Rae Reviewer', 5, ${mark + '-review'})`);
  await put('staff_members', () => sql`INSERT INTO staff_members (workspace_id, user_id, name, email) VALUES (${ws}, ${otherUserId}, ${mark + '-helper'}, ${`helper-${mark}@example.com`})`);
  await put('waitlist_entries', async () => {
    const svc = (await sql`INSERT INTO services (workspace_id, name, duration_minutes, price) VALUES (${ws}, ${mark + '-service'}, 60, 80) RETURNING id`).rows[0].id;
    await sql`INSERT INTO waitlist_entries (workspace_id, service_id, client_name, client_email, date, start_min, end_min, notes) VALUES (${ws}, ${svc}, 'Wait Lister', ${`wait-${mark}@example.com`}, CURRENT_DATE + 3, 600, 660, ${mark + '-waitlist'})`;
  });
  await put('cancellation_policy_versions', () => sql`INSERT INTO cancellation_policy_versions (workspace_id, version, body, body_sha256) VALUES (${ws}, 1, ${mark + '-policy'}, 'abc')`);
  await put('ivy_memory', () => sql`INSERT INTO ivy_memory (workspace_id, content) VALUES (${ws}, ${mark + '-memory'})`);
  await put('ivy_actions', () => sql`INSERT INTO ivy_actions (workspace_id, tool, kind) VALUES (${ws}, ${mark + '-tool'}, 'write')`);
  await put('group_threads', () => sql`INSERT INTO group_threads (workspace_id, name) VALUES (${ws}, ${mark + '-group'})`);
  let programId = null;
  await put('programs', async () => { programId = (await sql`INSERT INTO programs (workspace_id, title) VALUES (${ws}, ${mark + '-program'}) RETURNING id`).rows[0].id; });
  await put('program_modules', () => sql`INSERT INTO program_modules (program_id, workspace_id, title) VALUES (${programId}, ${ws}, ${mark + '-module'})`);
  await put('program_enrollments', () => sql`INSERT INTO program_enrollments (program_id, workspace_id, client_id, source, status) VALUES (${programId}, ${ws}, ${client}, 'manual', 'active')`);
  await put('shops', () => sql`INSERT INTO shops (owner_workspace_id, slug, name, join_token_hash) VALUES (${ws}, ${`shop-${mark}`.toLowerCase()}, ${mark + '-shop'}, ${'JOINHASHLEAK-' + mark})`);
  return ok;
}

async function main() {
  await ensureSchemaApplied();

  console.log('\n[1] the list');
  const cols = (await sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`).rows;
  const has = (t, c) => cols.some((r) => r.table_name === t && r.column_name === c);
  const broken = EXTRA_TABLES.filter(([, table, scope]) => !has(table, scope)).map(([, table, scope]) => `${table}.${scope}`);
  assert(broken.length === 0, `every listed table exists and has the column that ties it to a business${broken.length ? ': ' + broken.join(', ') : ''}`);
  assert(new Set(EXPORTED_EXTRA_KEYS).size === EXPORTED_EXTRA_KEYS.length && EXPORTED_EXTRA_KEYS.length >= 45, `no kind of record is listed twice (${EXPORTED_EXTRA_KEYS.length} kinds added)`);
  const internal = ['audit_events', 'risk_events', 'abuse_reports', 'bug_reports', 'billing_conflicts', 'billing_trial_claims', 'ivy_failures', 'ivy_pending_actions', 'notifications', 'screen_visits', 'exit_answers',
    'referral_reward_ledger', 'program_posts', 'program_post_reactions', 'client_dm_messages', 'client_dm_threads', 'contact_blocks', 'helper_invites', 'group_invite_tokens', 'cancellation_policy_requests', 'webhook_event_dedup', 'users', 'legal_acceptances'];
  const listed = EXTRA_TABLES.map(([, table]) => table);
  assert(internal.every((t) => !listed.includes(t)), 'Ivy\'s own operating records, one-time links, and what other people wrote privately are not on the list');
  const src = read('api/_lib/accountExport.js');
  assert(/\.query\(`SELECT \* FROM \$\{table\} WHERE \$\{scope\} = \$1`, \[workspaceId\]\)/.test(src) && !/information_schema/.test(src), 'each is read for one business only, from the fixed list and never from "every table"');

  console.log('\n[2] what goes in comes out');
  const other = await mkBusiness('other');
  const mine = await mkBusiness('mine');
  const filledMine = await fill(mine, `MINE${S}`, other.uid);
  const filledOther = await fill(other, `OTHER${S}`, mine.uid);
  const failed = Object.entries(filledMine).filter(([, v]) => v !== true);
  assert(failed.length === 0 && Object.values(filledOther).every((v) => v === true), `the test could create a row of each kind${failed.length ? ': ' + failed.map(([k, v]) => `${k} (${v})`).join('; ') : ''}`);
  const out = await buildAccountExport({ id: mine.uid, email: mine.email });
  const json = JSON.stringify(out);
  assert(EXPORTED_EXTRA_KEYS.every((k) => Array.isArray(out[k])), 'every added kind of record is in the file, as a list (empty when there is none)');
  const missing = Object.keys(filledMine).filter((k) => !(out[k] || []).length);
  assert(missing.length === 0, `each row created is in the file under its own heading${missing.length ? ': missing ' + missing.join(', ') : ''}`);
  for (const word of ['profile', 'quote', 'recurring', 'project', 'product', 'package', 'membership', 'giftcard', 'workflow', 'campaign', 'review', 'helper', 'waitlist', 'policy', 'memory', 'tool', 'group', 'program', 'module', 'shop']) {
    if (!json.includes(`MINE${S}-${word}`)) { assert(false, `the ${word} row's own text is in the file`); }
  }
  assert(json.includes(`MINE${S}-program`) && json.includes(`MINE${S}-giftcard`) && json.includes(`MINE${S}-workflow`), 'programs, gift cards and automations, which the file used to leave out, are there');
  assert(out.clients.length === 1 && out.ivy_export_version === 1 && Array.isArray(out.invoices) && Array.isArray(out.bookings), 'everything the file held before is still there');

  console.log('\n[3] one business only');
  assert(!json.includes(`OTHER${S}`) && !json.includes(other.email) && !json.includes(other.ws), 'nothing of the other business is in the file: not a row, not its email, not its id');
  const outOther = JSON.stringify(await buildAccountExport({ id: other.uid, email: other.email }));
  assert(!outOther.includes(`MINE${S}`) && outOther.includes(`OTHER${S}-program`), 'and the other business gets its own rows and none of these');

  console.log('\n[4] no secrets, no sign-in numbers');
  assert(!json.includes('HASHLEAK') && !json.includes('bcrypt-secret-value'), 'no quote link hash, gift card code hash, shop invite hash or password hash value');
  const keys = new Set(); const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  for (const k of EXPORTED_EXTRA_KEYS) walk(out[k]);
  const bad = [...keys].filter((k) => /secret|password|encrypted|token_hash|code_hash|(^|_)user_id$/i.test(k));
  assert(bad.length === 0, `no column named like a secret or a sign-in number in the added records${bad.length ? ': ' + bad.join(', ') : ''}`);
  assert(!json.includes(other.uid), 'the other person\'s sign-in number (set on the review and the helper row) is not in the file');
  assert(out.gift_cards[0].code_last4 === '1234' && out.reviews[0].reviewer_name === 'Rae Reviewer' && out.staff_members[0].email === `helper-MINE${S}@example.com`, 'while the useful parts of those rows are (last four of the code, the reviewer\'s name, the helper\'s email)');

  console.log('\n[5] what Ivy says about the export');
  const account = read('src/features/account/AccountPage.jsx');
  assert(/quotes and\s+payments, messages, documents, programs, products, packages,\s+memberships, gift cards, automations, reviews/.test(account) && /Files you uploaded are not inside it/.test(account) && !/JSON file with every row/.test(account), 'the card in the app lists what the file holds and says uploaded files are not in it');
  const security = read('src/features/marketing/SecurityPage.jsx'); const about = read('src/features/marketing/site/SiteAbout.jsx');
  const llms = read('public/llms.txt') + read('public/llms-full.txt');
  assert(!/complete export|everything you've put|CSV \+ JSON/.test(security) && /in one JSON file/.test(security) && !/Export everything|complete data/.test(about) && !/export everything|complete export|as CSV and JSON/i.test(llms),
    'the site no longer says "complete", "everything" or "CSV" about this download; it says one JSON file');
}

main().catch((e) => { console.error('crashed:', e); fail++; }).finally(async () => {
  for (const { uid, ws } of made) {
    await sql`DELETE FROM shops WHERE owner_workspace_id = ${ws}`.catch(() => {});
    await sql`DELETE FROM workspaces WHERE id = ${ws}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
  }
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
