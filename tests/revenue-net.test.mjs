// Every revenue figure counts the money the business actually kept from its
// invoices (net of refunds), from one shared SQL function
// (invoice_net_revenue in schema.js), so no two screens can disagree:
// finance totals, the dashboard, Ivy's numbers, goals, the weekly recap,
// client metrics, the POS drawer, the tax and accounting exports and the
// admin revenue view.
//
// The cases, all paid this month by one client:
//   A  paid $100 in full                                    keeps $100
//   B  paid $100, $30 refunded                              keeps $70
//   C  paid $50, refunded in full                           keeps $0
//   D  voided                                               keeps $0
//   E  $60 part payment refunded, then $100 paid in full    keeps $100
//      (it used to read $40: total minus every refund ever)
//   F  paid in full by a $40 gift card                      keeps $40 for
//      the business (a redemption); $0 in the platform view, which counts
//      the gift card when it is sold
// Business total: $310. Platform invoice revenue: $270.
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/revenue-net.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.STRIPE_SECRET_KEY = 'sk_test_revnet';
process.env.ADMIN_SECRET ||= 'test-admin-secret';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { refundInvoice } from '../api/_lib/refunds.js';
import { markInvoicePaid } from '../api/_lib/invoicePayments.js';
import { keyNumbers } from '../api/_lib/dashboardNumbers.js';
import { workspaceContext } from '../api/_lib/ivy.js';
import { executeIvyTool } from '../api/_lib/ivyTools.js';
import { computeGoalCurrent } from '../api/_lib/goals.js';
import { buildWeekStats } from '../api/_lib/weeklyRecap.js';
import financeHandler from '../api/finance/index.js';
import dashboardHandler from '../api/dashboard.js';
import taxExport from '../api/finance/tax-export.js';
import accountingExport from '../api/finance/accounting-export.js';
import clientMetrics from '../api/clients/metrics.js';
import posToday from '../api/pos/today.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const STAMP = Date.now();
let refundN = 0;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (/api\.stripe\.com\/v1\/refunds/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    return json({ id: `re_rn_${STAMP}_${++refundN}`, amount: Number(body.amount), status: 'succeeded' });
  }
  return json({ id: 'x' });
};
function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    send(s) { this.body = s; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
const HOST = 'www.joinivy.ai';
let cookie;
const get = async (handler, query = {}) => {
  const res = mkRes();
  await handler({ method: 'GET', url: '/t', query, body: {}, headers: { cookie, origin: `https://${HOST}`, host: HOST, 'x-forwarded-for': '198.18.94.2' } }, res);
  return res;
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

let uid, wid, cid;
async function mkInvoice(label, amount) {
  return (await sql`INSERT INTO invoices (workspace_id, client_id, client_name, number, status, items, tax_rate, discount, sent_at, due_date, issue_date)
    VALUES (${wid}, ${cid}, 'Casey Client', ${`RN-${label}-${STAMP}`}, 'sent', ${JSON.stringify([{ id: 'li1', description: 'Session', quantity: 1, rate: amount }])}::jsonb, 0, 0, NOW(), CURRENT_DATE + 14, CURRENT_DATE)
    RETURNING id`).rows[0].id;
}
const payCard = (id, cents, tag) => markInvoicePaid({ workspaceId: wid, invoiceId: id, paymentIntent: `pi_rn_${tag}_${STAMP}`, amountCents: cents, method: 'card' });

async function run() {
  await ensureSchemaApplied();
  uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`rn-${STAMP}@example.com`}, 'x', 'Owner', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, 'Net Revenue Studio', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status) VALUES (${wid}, ${`acct_rn_${STAMP}`}, 'complete')`;
  cid = (await sql`INSERT INTO clients (workspace_id, name, email, stage) VALUES (${wid}, 'Casey Client', ${`rn-client-${STAMP}@example.com`}, 'active') RETURNING id`).rows[0].id;
  cookie = `ivy_session=${signSession(uid)}`;

  console.log('\n[setup] the six invoices');
  const A = await mkInvoice('A', 100); await payCard(A, 10000, 'a');
  const B = await mkInvoice('B', 100); await payCard(B, 10000, 'b');
  await refundInvoice({ workspaceId: wid, id: B, amount: 30 });
  const C = await mkInvoice('C', 50); await payCard(C, 5000, 'c');
  await refundInvoice({ workspaceId: wid, id: C });
  const D = await mkInvoice('D', 80);
  await sql`UPDATE invoices SET status = 'voided' WHERE id = ${D}`;
  const E = await mkInvoice('E', 100); await payCard(E, 6000, 'e1');
  await refundInvoice({ workspaceId: wid, id: E, amount: 60 });
  await payCard(E, 10000, 'e2');
  const F = await mkInvoice('F', 40);
  await sql`UPDATE invoices SET gift_card_credit_cents = 4000 WHERE id = ${F}`;
  await markInvoicePaid({ workspaceId: wid, invoiceId: F, paymentIntent: null, amountCents: 4000, method: 'gift_card' });
  const st = (await sql`SELECT number, status, paid_amount, refunded_amount FROM invoices WHERE workspace_id = ${wid} ORDER BY number`).rows;
  assert(st.map((r) => r.status).join(',') === 'paid,paid,refunded,voided,paid,paid', `statuses (${st.map((r) => `${r.number.split('-')[1]}:${r.status}`).join(' ')})`);

  console.log('\n[1] the shared function, per invoice');
  const per = Object.fromEntries((await sql`SELECT number, invoice_net_revenue(i) AS kept, invoice_net_revenue(i, FALSE) AS cash FROM invoices i WHERE workspace_id = ${wid}`).rows
    .map((r) => [r.number.split('-')[1], [Number(r.kept), Number(r.cash)]]));
  assert(near(per.A[0], 100) && near(per.B[0], 70) && near(per.C[0], 0) && near(per.D[0], 0) && near(per.E[0], 100) && near(per.F[0], 40),
    `kept: A 100, B 70, C 0, D 0, E 100, F 40 (${JSON.stringify(per)})`);
  assert(near(per.F[1], 0) && near(per.E[1], 100), 'cash collected leaves the gift card redemption out');

  console.log('\n[2] every surface agrees: $310');
  const fin = (await get(financeHandler)).body?.summary;
  assert(near(fin?.totalPaid, 310) && near(fin?.monthPaid, 310), `finance totals (${fin?.totalPaid} / ${fin?.monthPaid})`);
  const kn = await keyNumbers(wid);
  assert(near(kn?.revenue?.thisMonth, 310), `dashboard key numbers (${kn?.revenue?.thisMonth})`);
  const dash = (await get(dashboardHandler)).body;
  assert(near(dash?.revenueVsExpenses?.revenue, 310) && near(dash?.keyNumbers?.revenue?.thisMonth, 310), `dashboard money (${dash?.revenueVsExpenses?.revenue})`);
  const ctx = await workspaceContext(wid);
  assert(near(ctx?.revenueThisMonth, 310), `Ivy's snapshot (${ctx?.revenueThisMonth})`);
  const tctx = { workspaceId: wid, userId: uid, sessionId: null };
  const ds = await executeIvyTool('get_dashboard_summary', {}, tctx);
  const pl = await executeIvyTool('get_pl_summary', {}, tctx);
  assert(near(ds?.revenue_this_month, 310) && near(pl?.this_month?.revenue, 310), `Ivy's tools (${ds?.revenue_this_month} / ${pl?.this_month?.revenue})`);
  assert(near(await computeGoalCurrent(wid, 'revenue'), 310), 'revenue goal progress');
  const wk = await buildWeekStats({ workspaceId: wid, from: new Date(Date.now() - 7 * 86400000), to: new Date(Date.now() + 60000) });
  assert(near(wk?.revenuePaid, 310), `weekly recap "collected" (${wk?.revenuePaid})`);
  const cm = (await get(clientMetrics, { id: cid })).body?.metrics;
  assert(cm?.revenue30dCents === 31000, `client 30-day revenue (${cm?.revenue30dCents})`);
  const pos = (await get(posToday)).body;
  assert(near(pos?.paidTotal, 310), `POS today's paid total (${pos?.paidTotal})`);

  console.log('\n[3] exports');
  const year = new Date().getUTCFullYear();
  const tax = String((await get(taxExport, { year: String(year) })).body || '');
  const netLine = tax.split('\r\n').find((l) => /^"?Net income/.test(l)) || '';
  assert(/310\.00/.test(netLine), `tax export net income (${netLine})`);
  const eRow = tax.split('\r\n').find((l) => l.includes(`RN-E-${STAMP}`)) || '';
  assert(/100\.00/.test(eRow) && !/40\.00/.test(eRow), `tax export: invoice E nets $100 (${eRow})`);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const acc = String((await get(accountingExport, { format: 'quickbooks', type: 'invoices', from, to })).body || '');
  const accRows = acc.split('\r\n').filter((l) => l.includes(`RN-`) && l.includes(String(STAMP)));
  const amounts = accRows.map((l) => l.split(',')).map((cols) => Number(String(cols[11] || '0').replace(/"/g, '')));
  const accNet = Math.round(amounts.reduce((n, v) => n + v, 0) * 100) / 100;
  assert(near(accNet, 310), `accounting export lines net to $310 (${accNet})`);

  console.log('\n[4] the platform view: $270 from invoices (gift card counted when sold)');
  const wr = (await sql`SELECT invoices FROM workspace_revenue WHERE workspace_id = ${wid}`).rows[0];
  assert(near(wr?.invoices, 270), `workspace_revenue.invoices (${wr?.invoices})`);

  console.log('\n[5] no revenue query works it out on its own');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
  const offenders = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.js') && !/schema\.js$/.test(f.name)) {
        const s = fs.readFileSync(p, 'utf8');
        if (/total\s*-\s*COALESCE\(refunded_amount|COALESCE\(paid_amount,\s*total\)\s*-|SUM\(paid_amount\)/.test(s)) offenders.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert(offenders.length === 0, `every revenue query uses invoice_net_revenue (${offenders.join(', ')})`);
}

run()
  .catch((err) => { console.error('Fatal:', err.message, err.stack); fail++; })
  .finally(async () => {
    if (wid) {
      await sql`DELETE FROM invoice_payments WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM invoices WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM clients WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM finance_settings WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${wid}`.catch(() => {});
    }
    if (uid) await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
