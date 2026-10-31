// CSV formula injection. Every text/csv writer (finance accounting +
// tax exports, admin users/affiliates + waitlist exports) goes through
// api/_lib/csv.js, which prefixes a cell starting with = + - @ TAB or CR
// with a single quote so a spreadsheet shows it as text instead of
// running it. Plain numbers ("-12.50" refunds) are left alone.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/csv-injection.test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { csvCell, csvRow } from '../api/_lib/csv.js';
import accountingExport from '../api/finance/accounting-export.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, chunks: [],
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    write(s) { this.chunks.push(String(s)); return true; },
    send(s) { this.body = s; return this; },
    end(s) { if (s !== undefined) this.chunks.push(String(s)); return this; },
  };
}
const text = (r) => (typeof r.body === 'string' ? r.body : '') + r.chunks.join('');

const STAMP = Date.now();
let userId, wsId;

async function run() {
  console.log('\n[1] csvCell neutralises formula leads');
  assert(csvCell('=SUM(A1:A9)') === "'=SUM(A1:A9)", '= prefixed');
  assert(csvCell('+1+1') === "'+1+1", '+ prefixed (not a plain number)');
  assert(csvCell('-2+3') === "'-2+3", '- prefixed (not a plain number)');
  assert(csvCell('@SUM(1)') === "'@SUM(1)", '@ prefixed');
  assert(csvCell('\tcmd') === '"\'\tcmd"', 'TAB lead prefixed and quoted');
  assert(csvCell('\rcmd') === '"\'\rcmd"', 'CR lead prefixed and quoted');
  assert(csvCell('=HYPERLINK("http://x","y")') === '"\'=HYPERLINK(""http://x"",""y"")"', 'prefixed AND quoted, inner quotes doubled');
  assert(csvCell('-12.50') === '-12.50', 'negative amount left as a number');
  assert(csvCell('+44') === '+44', 'signed integer left as a number');
  assert(csvCell('Ada Lovelace') === 'Ada Lovelace', 'plain text unchanged');
  assert(csvCell('a,b') === '"a,b"', 'comma still quoted');
  assert(csvCell(null) === '' && csvCell(undefined) === '', 'null/undefined are empty');
  assert(csvCell(0) === '0' && csvCell(-3) === '-3', 'numbers pass through');
  assert(csvRow('=1+1', 'ok', -5) === "'=1+1,ok,-5", 'csvRow encodes every cell');

  console.log('\n[2] every CSV writer uses the shared encoder');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of ['api/finance/accounting-export.js', 'api/finance/tax-export.js', 'api/admin/export.js', 'api/admin/waitlist.js']) {
    const src = readFileSync(path.join(root, ...f.split('/')), 'utf8');
    assert(/from '\.\.\/_lib\/csv\.js'/.test(src) && !/function csvCell/.test(src), `${f} imports api/_lib/csv.js, no local csvCell`);
  }

  console.log('\n[3] accounting export: a hostile client name comes out as text');
  await ensureSchemaApplied();
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`csvinj-${STAMP}@example.com`}, 'x', 'Csv Owner', NOW()) RETURNING id`;
  userId = u.rows[0].id;
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${userId}, 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`;
  wsId = w.rows[0].id;
  const evil = '=HYPERLINK("http://evil.example","Click")';
  await sql`INSERT INTO invoices (workspace_id, client_name, client_email, number, status, items, tax_rate, discount, total, paid_amount, paid_at, issue_date)
    VALUES (${wsId}, ${evil}, ${'@bad@example.com'}, ${'INV-CSV-' + STAMP}, 'paid',
      '[{"description":"+cmd|calc","quantity":1,"rate":100}]'::jsonb, 0, 0, 100, 100, NOW(), CURRENT_DATE)`;
  const year = new Date().getUTCFullYear();
  for (const format of ['quickbooks', 'xero']) {
    const r = mockRes();
    // eslint-disable-next-line no-await-in-loop
    await accountingExport({ method: 'GET', url: '/test', query: { format, type: 'invoices', year: String(year) }, body: {},
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000', 'x-forwarded-for': '198.51.100.77', cookie: `ivy_session=${signSession(userId)}` } }, r);
    const out = text(r);
    assert(r.statusCode === 200 && out.includes('INV-CSV-'), `${format}: export 200 with the invoice (${r.statusCode})`);
    const cells = out.split('\n').join(',');
    assert(out.includes('"\'=HYPERLINK(""http://evil.example"",""Click"")"'), `${format}: client name prefixed with a quote`);
    assert(!/(^|,)=HYPERLINK/.test(cells) && !/(^|,)"=HYPERLINK/.test(cells), `${format}: no cell starts with =`);
    assert(!/(^|,)\+cmd/.test(cells), `${format}: line description starting with + neutralised`);
  }
}

async function cleanup() {
  try {
    if (wsId) await sql`DELETE FROM workspaces WHERE id = ${wsId}`;
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
  } catch (e) { console.error('cleanup:', e.message); }
}

run()
  .catch((e) => { fail++; console.error(e); })
  .finally(async () => {
    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
