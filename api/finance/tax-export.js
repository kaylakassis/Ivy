// GET /api/finance/tax-export?year=2026
//
// Schedule C-style year-end summary, returned as CSV. Two sections:
//   1. Income: every paid invoice in the year, grouped by month, with
//      net (gross − refunded) and the refund column for transparency.
//   2. Expenses: every expense in the year, grouped by Schedule C
//      category line, with line totals at the top and raw items below.
//
// Net result row at the bottom: net income − total deductible expenses
// = the gross profit Schedule C line 31 wants. Owner imports this into
// TurboTax / Wave / their CPA's spreadsheet without any reformatting.
import { sql } from '../_lib/db.js';
import { requireUser } from '../_lib/auth.js';
import { ensureActiveWorkspace } from '../_lib/workspaceGate.js';
import { requireSameOrigin } from '../_lib/security.js';
import { SCHEDULE_C_CATEGORIES } from '../_lib/expenses.js';
import { badRequest, methodNotAllowed, serverError } from '../_lib/json.js';

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function row(...cells) { return cells.map(csvCell).join(','); }
function n(num) { return Number(num || 0).toFixed(2); }

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureActiveWorkspace(user, req, res);
    if (!workspaceId) return;

    const year = parseInt(req.query.year, 10);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return badRequest(res, 'year must be a 4-digit year');
    }
    const yearStart = `${year}-01-01`;
    const yearEnd   = `${year}-12-31`;

    const [invRes, expRes, bizRes] = await Promise.all([
      // Paid invoices that paid out in this year. Use COALESCE(paid_at,
      // issue_date) so legacy mark-paid rows without a paid_at still
      // show up.
      sql.query(
        `SELECT id, number, client_name, paid_at, issue_date,
                items, tax_rate, discount, refunded_amount
         FROM invoices
         WHERE workspace_id = $1
           AND status IN ('paid', 'refunded')
           AND COALESCE(paid_at::date, issue_date) BETWEEN $2 AND $3
         ORDER BY COALESCE(paid_at, issue_date) ASC`,
        [workspaceId, yearStart, yearEnd],
      ),
      sql.query(
        `SELECT * FROM expenses
         WHERE workspace_id = $1 AND date BETWEEN $2 AND $3
         ORDER BY date ASC, category ASC`,
        [workspaceId, yearStart, yearEnd],
      ),
      sql.query(
        `SELECT cs.biz_name FROM calendar_settings cs WHERE cs.workspace_id = $1`,
        [workspaceId],
      ),
    ]);

    const bizName = bizRes.rows[0]?.biz_name || 'My business';

    // Compute invoice totals same way the rest of the app does
    // (subtotal − discount + tax). Refunded amount nets out.
    const incomeRows = [];
    let grossIncome = 0;
    let refunds = 0;
    for (const r of invRes.rows) {
      const items = r.items || [];
      const subtotal = items.reduce((s, it) => s + Number(it.quantity || 0) * Number(it.rate || 0), 0);
      const taxable  = Math.max(0, subtotal - Number(r.discount || 0));
      const tax      = taxable * (Number(r.tax_rate || 0) / 100);
      const total    = Math.round((taxable + tax) * 100) / 100;
      const refunded = Math.round(Number(r.refunded_amount || 0) * 100) / 100;
      const net      = Math.round((total - refunded) * 100) / 100;
      grossIncome += total;
      refunds     += refunded;
      const dateISO = r.paid_at instanceof Date
        ? r.paid_at.toISOString().slice(0, 10)
        : (r.issue_date instanceof Date ? r.issue_date.toISOString().slice(0, 10) : r.issue_date);
      incomeRows.push({ date: dateISO, number: r.number, client: r.client_name, gross: total, refunded, net });
    }

    // Expenses bucketed by Schedule C key. Keep both summary + raw rows.
    const byCategory = new Map();
    let totalExpenses = 0;
    for (const e of expRes.rows) {
      if (!e.is_deductible) continue;
      const key = e.category;
      const cur = byCategory.get(key) || { total: 0, count: 0, items: [] };
      cur.total += Number(e.amount || 0);
      cur.count += 1;
      cur.items.push(e);
      byCategory.set(key, cur);
      totalExpenses += Number(e.amount || 0);
    }

    // Build CSV.
    const lines = [];
    lines.push(row(`Ivy OS - Tax export for ${bizName} - ${year}`));
    lines.push(row('Generated', new Date().toISOString()));
    lines.push('');
    lines.push(row('SUMMARY'));
    lines.push(row('Gross income (paid invoices)', n(grossIncome)));
    lines.push(row('Refunds', n(refunds)));
    lines.push(row('Net income (line 1 of Schedule C)', n(grossIncome - refunds)));
    lines.push(row('Total deductible expenses (line 28)', n(totalExpenses)));
    lines.push(row('Tentative profit (line 29)', n(grossIncome - refunds - totalExpenses)));
    lines.push('');

    lines.push(row('EXPENSES BY CATEGORY (Schedule C lines)'));
    lines.push(row('Schedule C line', 'Category', 'Total', 'Count'));
    for (const cat of SCHEDULE_C_CATEGORIES) {
      const v = byCategory.get(cat.key);
      if (!v) continue;
      lines.push(row(cat.line, cat.label, n(v.total), v.count));
    }
    lines.push('');

    lines.push(row('EXPENSES - RAW LINE ITEMS'));
    lines.push(row('Date', 'Schedule C line', 'Category', 'Vendor', 'Amount', 'Method', 'Notes'));
    for (const cat of SCHEDULE_C_CATEGORIES) {
      const v = byCategory.get(cat.key);
      if (!v) continue;
      for (const e of v.items) {
        const dateISO = e.date instanceof Date ? e.date.toISOString().slice(0, 10) : e.date;
        lines.push(row(dateISO, cat.line, cat.label, e.vendor || '', n(e.amount), e.payment_method || '', e.notes || ''));
      }
    }
    lines.push('');

    lines.push(row('INCOME - PAID INVOICES'));
    lines.push(row('Date', 'Number', 'Client', 'Gross', 'Refunded', 'Net'));
    for (const r of incomeRows) {
      lines.push(row(r.date, r.number, r.client, n(r.gross), n(r.refunded), n(r.net)));
    }

    const csv = lines.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ivy-tax-${year}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    return serverError(res, err);
  }
}
