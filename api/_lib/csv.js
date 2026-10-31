// One CSV cell encoder for every text/csv download the app serves
// (finance exports, admin exports).
//
// Besides the usual quoting, a cell that starts with = + - @ TAB or CR is
// prefixed with a single quote so a spreadsheet opening the file treats
// it as text instead of evaluating it as a formula (CSV injection via a
// client name like "=HYPERLINK(...)"). Plain numbers are exempt: "-12.50"
// is a refund, not a formula, and prefixing it would break imports.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (FORMULA_LEAD.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  if (/[",\r\n\t]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(...cells) {
  return cells.map(csvCell).join(',');
}
