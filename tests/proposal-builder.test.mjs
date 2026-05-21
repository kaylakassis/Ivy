// Tests for the Proposal/package builder.
//   • cleanQuoteItems / isIncluded / quoteTotals option semantics.
//   • Accepting a proposal honors the client's selection: only chosen
//     items (required + selected add-ons + one package tier) become the
//     invoice, one-per-group is enforced, and totals are correct.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/proposal-builder.test.mjs

import crypto from 'node:crypto';
import { sql } from '../api/_lib/db.js';
import { isIncluded, quoteTotals, cleanQuoteItems } from '../api/_lib/quotes.js';
import quoteView from '../api/quote-view/[token].js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
function mockRes() {
  return { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; },
    setHeader() {}, end() { return this; } };
}

const createdUsers = [];
async function run() {
  try {
    console.log('\n[unit] cleanQuoteItems / isIncluded / quoteTotals');
    const cleaned = cleanQuoteItems([
      { id: 'r',  description: 'R',  quantity: 1, rate: 100 },
      { id: 'a',  description: 'A',  quantity: 1, rate: 20, optional: true, selected: false },
      { id: 't1', description: 'T1', quantity: 1, rate: 50, packageGroup: 'Tier', selected: true },
      { id: 't2', description: 'T2', quantity: 1, rate: 80, packageGroup: 'Tier', selected: false },
    ]);
    const byId = Object.fromEntries(cleaned.map((it) => [it.id, it]));
    assert(byId.r.optional === false && byId.r.selected === true, 'required item: optional=false, selected=true');
    assert(byId.a.optional === true && byId.a.selected === false, 'optional add-on preserves optional + default-unselected');
    assert(byId.t1.packageGroup === 'Tier' && byId.t1.optional === true, 'package item implies optional + keeps group');
    assert(isIncluded(byId.r) && !isIncluded(byId.a) && isIncluded(byId.t1) && !isIncluded(byId.t2),
      'isIncluded: required + selected-tier in; unselected add-on/tier out');
    assert(quoteTotals(cleaned, 0, 0).total === 150, 'default total = required(100) + tier T1(50) = 150');

    console.log('\n[e2e] accepting a proposal builds an invoice from the selection');
    const u = await sql`INSERT INTO users (email, password_hash, terms_version, terms_accepted_at)
      VALUES (${`pb-${Date.now()}@example.com`}, 'x', '2026-05-05', NOW()) RETURNING id`;
    createdUsers.push(u.rows[0].id);
    const wid = (await sql`INSERT INTO workspaces (owner_id) VALUES (${u.rows[0].id}) RETURNING id`).rows[0].id;
    const raw = crypto.randomBytes(20).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const q = await sql`
      INSERT INTO quotes (workspace_id, number, client_name, client_email, items, tax_rate, discount, status, view_token_hash)
      VALUES (${wid}, 'EST-PB', 'Client', 'c@example.com', ${JSON.stringify(cleaned)}::jsonb, 0, 0, 'sent', ${hash})
      RETURNING id`;

    const res = mockRes();
    await quoteView({
      method: 'POST', headers: {}, query: { token: raw },
      // Client picks: add-on A, switch tier to T2 (deselect T1).
      body: { action: 'accept', selections: [
        { id: 'a', selected: true }, { id: 't1', selected: false }, { id: 't2', selected: true },
      ] },
    }, res);

    assert(res.statusCode === 200 && res.body?.accepted, 'accept returns 200 + accepted');
    const inv = (await sql`SELECT * FROM invoices WHERE workspace_id = ${wid} ORDER BY created_at DESC LIMIT 1`).rows[0];
    const invIds = (inv?.items || []).map((it) => it.id).sort();
    assert(JSON.stringify(invIds) === JSON.stringify(['a', 'r', 't2']), `invoice has R + A + T2 (got ${invIds})`);
    const invTotal = (inv?.items || []).reduce((s, it) => s + Number(it.quantity) * Number(it.rate), 0);
    assert(invTotal === 200, `invoice total = 100 + 20 + 80 = 200 (got ${invTotal})`);

    const qrow = (await sql`SELECT status, items FROM quotes WHERE id = ${q.rows[0].id}`).rows[0];
    assert(qrow.status === 'accepted', 'quote marked accepted');
    const qById = Object.fromEntries(qrow.items.map((it) => [it.id, it]));
    assert(qById.a.selected === true && qById.t1.selected === false && qById.t2.selected === true,
      'quote stores the client\'s final selection');
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
