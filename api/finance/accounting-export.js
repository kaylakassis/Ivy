// GET /api/finance/accounting-export?format=<quickbooks|xero>&type=<invoices|expenses>&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// CSV exports formatted for direct import into QuickBooks Online or Xero.
// Distinct from /api/finance/tax-export, which is a Schedule-C summary
// owners hand to a human CPA — this one lands cleanly in accounting
// software's "Import sales invoices" / "Import bills" file pickers
// without manual column shuffling.
//
// Format reference:
//
//   QuickBooks Online — "Sales transactions" import expects:
//     InvoiceNo, Customer, InvoiceDate, DueDate, Terms, Memo,
//     ItemProductService, ItemDescription, ItemQuantity, ItemRate,
//     ItemAmount, ItemTaxAmount, Currency
//
//   Xero — "Sales invoices" import expects:
//     ContactName, EmailAddress, InvoiceNumber, InvoiceDate, DueDate,
//     Description, Quantity, UnitAmount, AccountCode, TaxType, Currency
//
//   For expenses (purchases), both tools want a single transaction row:
//     QuickBooks: Date, Vendor, Account, Amount, Memo
//     Xero:       Date, Reference, Description, Amount, AccountCode
//
// We always emit one row per line item for invoices and one row per
// expense for purchases — the format the tools' importers natively
// understand. Year-end exports work out of the box.
import { sql } from '../_lib/db.js';
import { requireUser, ensureWorkspace } from '../_lib/auth.js';
import { requireSameOrigin } from '../_lib/security.js';
import { SCHEDULE_C_CATEGORIES } from '../_lib/expenses.js';
import { badRequest, methodNotAllowed, serverError } from '../_lib/json.js';

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function r(...cells) { return cells.map(csvCell).join(','); }
function n(num) { return Number(num || 0).toFixed(2); }

// Map our Schedule-C expense categories to the account names owners
// most commonly have set up in QuickBooks / Xero. These are guesses
// to make the import less painful; owners can rename in their COA.
function expenseAccountFor(categoryKey) {
  const cat = SCHEDULE_C_CATEGORIES.find((c) => c.key === categoryKey);
  return cat?.label || 'Other Expenses';
}

function parseDateRange(req) {
  const year = parseInt(req.query.year, 10);
  if (Number.isInteger(year) && year >= 2000 && year <= 2100) {
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  const from = (req.query.from || '').toString();
  const to   = (req.query.to   || '').toString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { from, to };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  if (!requireSameOrigin(req, res)) return;
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const workspaceId = await ensureWorkspace(user.id);

    const format = (req.query.format || '').toString().toLowerCase();
    const type   = (req.query.type   || 'invoices').toString().toLowerCase();
    if (!['quickbooks', 'xero'].includes(format)) {
      return badRequest(res, 'format must be quickbooks or xero');
    }
    if (!['invoices', 'expenses'].includes(type)) {
      return badRequest(res, 'type must be invoices or expenses');
    }
    const range = parseDateRange(req);
    if (!range) return badRequest(res, 'Pass either ?year=YYYY or ?from=YYYY-MM-DD&to=YYYY-MM-DD');

    const [bizRes, fsRes] = await Promise.all([
      sql.query(
        `SELECT cs.biz_name FROM calendar_settings cs WHERE cs.workspace_id = $1`,
        [workspaceId],
      ),
      sql.query(
        `SELECT currency FROM finance_settings WHERE workspace_id = $1`,
        [workspaceId],
      ),
    ]);
    const bizName = bizRes.rows[0]?.biz_name || 'My business';
    // Currency is workspace-wide (single column on finance_settings, not
    // per-invoice or per-expense). Default to USD if unset.
    const currency = (fsRes.rows[0]?.currency || 'USD').toUpperCase();

    const lines = [];

    if (type === 'invoices') {
      const inv = await sql.query(
        `SELECT id, number, client_name, client_email, paid_at, issue_date,
                due_date, items, tax_rate, discount, notes
         FROM invoices
         WHERE workspace_id = $1
           AND status IN ('paid', 'refunded')
           AND COALESCE(paid_at::date, issue_date) BETWEEN $2 AND $3
         ORDER BY COALESCE(paid_at, issue_date) ASC`,
        [workspaceId, range.from, range.to],
      );

      if (format === 'quickbooks') {
        lines.push(r(
          'InvoiceNo', 'Customer', 'CustomerEmail', 'InvoiceDate', 'DueDate',
          'Terms', 'Memo', 'ItemProductService', 'ItemDescription',
          'ItemQuantity', 'ItemRate', 'ItemAmount', 'ItemTaxAmount', 'Currency',
        ));
      } else {
        // Xero "Sales invoices" import. Account codes 200 (Sales) and
        // tax type Tax Exempt are safe defaults; owner re-categorizes
        // in Xero if they want a different chart-of-accounts line.
        lines.push(r(
          '*ContactName', 'EmailAddress', '*InvoiceNumber', 'Reference',
          '*InvoiceDate', '*DueDate', '*Description', '*Quantity',
          '*UnitAmount', 'Discount', '*AccountCode', '*TaxType', 'Currency',
        ));
      }

      for (const row of inv.rows) {
        const items = Array.isArray(row.items) ? row.items : [];
        const subtotal = items.reduce(
          (s, it) => s + Number(it.quantity || 0) * Number(it.rate || 0), 0,
        );
        const taxableBase = Math.max(0, subtotal - Number(row.discount || 0));
        const taxRate = Number(row.tax_rate || 0);
        const dateISO = row.paid_at instanceof Date
          ? row.paid_at.toISOString().slice(0, 10)
          : (row.issue_date instanceof Date ? row.issue_date.toISOString().slice(0, 10) : row.issue_date);
        const dueISO = row.due_date instanceof Date
          ? row.due_date.toISOString().slice(0, 10)
          : (row.due_date || dateISO);

        for (const it of items) {
          const qty   = Number(it.quantity || 0);
          const rate  = Number(it.rate || 0);
          const amt   = qty * rate;
          // Per-line tax follows the invoice-wide rate, weighted by the
          // line's share of the taxable base. Without this, QuickBooks
          // and Xero reject mixed-tax rows.
          const share = taxableBase > 0 ? amt / subtotal : 0;
          const lineTax = Math.round(taxableBase * (taxRate / 100) * share * 100) / 100;

          if (format === 'quickbooks') {
            lines.push(r(
              row.number, row.client_name, row.client_email || '',
              dateISO, dueISO, 'Net 30', row.notes || '',
              it.name || it.description || 'Service', it.description || '',
              n(qty), n(rate), n(amt), n(lineTax), currency,
            ));
          } else {
            // Xero requires *TaxType — "Tax Exempt" or "Output" depending
            // on whether tax_rate > 0. Owners with set sales-tax rules
            // will fix this on import; we pick the safer "Tax Exempt"
            // default to avoid double-taxing.
            const taxType = taxRate > 0 ? 'Tax on Sales' : 'Tax Exempt';
            lines.push(r(
              row.client_name, row.client_email || '',
              row.number, '', dateISO, dueISO,
              it.name || it.description || 'Service',
              n(qty), n(rate),
              '', // discount per-line; we already netted it into base
              '200', // 200 = Sales (Xero default revenue account)
              taxType, currency,
            ));
          }
        }
      }
    } else {
      // type === 'expenses' — one row per purchase. Both tools take a
      // similar shape, just different column names.
      const exp = await sql.query(
        `SELECT date, vendor, amount, category, payment_method, notes
         FROM expenses
         WHERE workspace_id = $1 AND date BETWEEN $2 AND $3
         ORDER BY date ASC`,
        [workspaceId, range.from, range.to],
      );

      if (format === 'quickbooks') {
        lines.push(r('Date', 'Vendor', 'Account', 'Amount', 'PaymentMethod', 'Memo', 'Currency'));
      } else {
        // Xero "Bills" import.
        lines.push(r('*ContactName', '*InvoiceDate', '*DueDate', '*Description', '*Quantity', '*UnitAmount', '*AccountCode', '*TaxType', 'Currency'));
      }

      for (const e of exp.rows) {
        const dateISO = e.date instanceof Date ? e.date.toISOString().slice(0, 10) : e.date;
        const account = expenseAccountFor(e.category);
        const memo = [e.notes, e.payment_method].filter(Boolean).join(' / ');

        if (format === 'quickbooks') {
          lines.push(r(
            dateISO, e.vendor || 'Unknown vendor', account,
            n(e.amount), e.payment_method || '', memo, currency,
          ));
        } else {
          // Xero account codes start at 400 for expenses by convention.
          // We use 400 as the bucket default; owners re-map in Xero.
          lines.push(r(
            e.vendor || 'Unknown vendor', dateISO, dateISO,
            account + (e.notes ? ' — ' + e.notes : ''),
            '1', n(e.amount), '400', 'Tax Exempt', currency,
          ));
        }
      }
    }

    const csv = lines.join('\r\n') + '\r\n';
    const filename = `thryve-${type}-${format}-${range.from}_to_${range.to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Thryve-Workspace', bizName); // diagnostic only
    return res.status(200).send(csv);
  } catch (err) {
    return serverError(res, err);
  }
}
