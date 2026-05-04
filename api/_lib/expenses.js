// Shared serializer + helpers for the expenses table.
//
// Categories track IRS Schedule C lines so the annual tax export
// aggregates without translation. We store the canonical key + the
// frontend renders friendly labels.
export const SCHEDULE_C_CATEGORIES = [
  { key: 'advertising',     label: 'Advertising',                   line: '8' },
  { key: 'car',             label: 'Car & truck expenses',          line: '9' },
  { key: 'commissions',     label: 'Commissions & fees',            line: '10' },
  { key: 'contract_labor',  label: 'Contract labor',                line: '11' },
  { key: 'depreciation',    label: 'Depreciation',                  line: '13' },
  { key: 'insurance',       label: 'Insurance (other than health)', line: '15' },
  { key: 'interest',        label: 'Interest (mortgage / other)',   line: '16' },
  { key: 'legal',           label: 'Legal & professional services', line: '17' },
  { key: 'office',          label: 'Office expense',                line: '18' },
  { key: 'rent',            label: 'Rent / lease',                  line: '20' },
  { key: 'repairs',         label: 'Repairs & maintenance',         line: '21' },
  { key: 'supplies',        label: 'Supplies',                      line: '22' },
  { key: 'taxes',           label: 'Taxes & licenses',              line: '23' },
  { key: 'travel',          label: 'Travel',                        line: '24a' },
  { key: 'meals',           label: 'Meals (deductible portion)',    line: '24b' },
  { key: 'utilities',       label: 'Utilities',                     line: '25' },
  { key: 'wages',           label: 'Wages',                         line: '26' },
  { key: 'other',           label: 'Other',                         line: '27a' },
];
export const SCHEDULE_C_KEYS = new Set(SCHEDULE_C_CATEGORIES.map((c) => c.key));

export const VALID_PAYMENT_METHODS = new Set(['card', 'cash', 'check', 'transfer', 'other']);

export function serializeExpense(row) {
  if (!row) return null;
  return {
    id:             row.id,
    amount:         Number(row.amount || 0),
    date:           row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
    category:       row.category,
    vendor:         row.vendor || null,
    notes:          row.notes || null,
    receiptUrl:     row.receipt_url || null,
    paymentMethod:  row.payment_method || null,
    isDeductible:   row.is_deductible == null ? true : !!row.is_deductible,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  };
}
