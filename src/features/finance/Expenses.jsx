// Expenses surface — list, add/edit modal, delete.
// Lives inside Finance.jsx alongside invoices (toggle at the top).
import React, { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';

// Mirror api/_lib/expenses.js. Kept in sync by hand — small + stable.
const CATEGORIES = [
  { key: 'advertising',     label: 'Advertising' },
  { key: 'car',             label: 'Car & truck' },
  { key: 'commissions',     label: 'Commissions & fees' },
  { key: 'contract_labor',  label: 'Contract labor' },
  { key: 'depreciation',    label: 'Depreciation' },
  { key: 'insurance',       label: 'Insurance' },
  { key: 'interest',        label: 'Interest' },
  { key: 'legal',           label: 'Legal & professional' },
  { key: 'office',          label: 'Office expense' },
  { key: 'rent',            label: 'Rent / lease' },
  { key: 'repairs',         label: 'Repairs & maintenance' },
  { key: 'supplies',        label: 'Supplies' },
  { key: 'taxes',           label: 'Taxes & licenses' },
  { key: 'travel',          label: 'Travel' },
  { key: 'meals',           label: 'Meals' },
  { key: 'utilities',       label: 'Utilities' },
  { key: 'wages',           label: 'Wages' },
  { key: 'other',           label: 'Other' },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function Expenses() {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [error, setError]     = useState(null);
  const [filterCat, setFilterCat] = useState('');

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get('/expenses' + (filterCat ? `?category=${filterCat}` : ''));
      setItems(r.expenses || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [filterCat]);

  const remove = async (id) => {
    if (!window.confirm('Delete this expense?')) return;
    await api.del(`/expenses/${id}`);
    await load();
  };

  const ytdTotal = useMemo(() => {
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
    return items
      .filter((e) => e.date >= yearStart && e.isDeductible)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
  }, [items]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <SummaryTile label="Deductible YTD" value={fmtMoney(ytdTotal)}
          hint={`${items.filter((e) => e.isDeductible).length} entries this year`}/>

        <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}
          style={{
            padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--border-strong)', background: 'var(--surface)',
            color: 'var(--fg)', fontSize: 13, marginLeft: 'auto',
          }}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
        <button className="btn btn-primary" onClick={() => setEditing({})}>
          <Icons.Plus size={13} sw={2}/> New expense
        </button>
      </div>

      {error && (
        <div style={{
          padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{error}</div>
      )}

      <div className="card" style={{ overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: 40 }}>
            <EmptyNote icon="Doc" title="No expenses yet"
              hint="Track your business spend by Schedule C category. Year-end export bundles them for tax filing."/>
          </div>
        ) : (
          <div>
            <div style={{
              display: 'grid', gridTemplateColumns: '110px 1fr 1fr 110px 110px 32px',
              padding: '10px 18px', fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase',
              fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
              background: 'var(--surface-2)',
            }}>
              <div>Date</div><div>Category</div><div>Vendor / notes</div>
              <div>Method</div>
              <div style={{ textAlign: 'right' }}>Amount</div>
              <div/>
            </div>
            {items.map((e, i) => (
              <div key={e.id} style={{
                display: 'grid', gridTemplateColumns: '110px 1fr 1fr 110px 110px 32px',
                padding: '12px 18px', alignItems: 'center', fontSize: 13,
                borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                cursor: 'pointer',
                opacity: e.isDeductible ? 1 : 0.6,
              }} onClick={() => setEditing(e)}>
                <div style={{ color: 'var(--fg-2)' }}>{fmtDate(e.date)}</div>
                <div>{CAT_LABEL[e.category] || e.category}</div>
                <div style={{ color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.vendor || ''}{e.vendor && e.notes ? ' · ' : ''}{e.notes || ''}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>{e.paymentMethod || ''}</div>
                <div className="mono-num" style={{ textAlign: 'right', fontWeight: 600 }}>
                  {fmtMoney(e.amount)}
                </div>
                <button onClick={(ev) => { ev.stopPropagation(); remove(e.id); }}
                  className="btn btn-ghost"
                  style={{ padding: '8px 10px', minHeight: 36, color: 'var(--muted)' }}
                  title="Delete">
                  <Icons.X size={13}/>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ExpenseEditor expense={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { await load(); setEditing(null); }}/>
      )}
    </div>
  );
}

function SummaryTile({ label, value, hint }) {
  return (
    <div className="card" style={{ padding: 16, minWidth: 200 }}>
      <div className="metric-label">{label}</div>
      <div className="mono-num" style={{ fontSize: 24, fontWeight: 600, marginTop: 2 }}>{value}</div>
      {hint && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function ExpenseEditor({ expense, onClose, onSaved }) {
  const isNew = !expense.id;
  const [amount, setAmount]     = useState(expense.amount ?? '');
  const [date, setDate]         = useState(expense.date || new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState(expense.category || 'supplies');
  const [vendor, setVendor]     = useState(expense.vendor || '');
  const [notes, setNotes]       = useState(expense.notes || '');
  const [paymentMethod, setPaymentMethod] = useState(expense.paymentMethod || 'card');
  const [isDeductible, setIsDeductible]   = useState(expense.isDeductible !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = {
        amount: Number(amount), date, category,
        vendor: vendor.trim() || null,
        notes: notes.trim() || null,
        paymentMethod, isDeductible,
      };
      if (isNew) await api.post('/expenses', body);
      else       await api.patch(`/expenses/${expense.id}`, body);
      onSaved();
    } catch (e2) {
      setErr(e2.message || 'Could not save');
      setBusy(false);
    }
  };

  return (
    <div onClick={() => !busy && onClose()} role="dialog" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onSubmit={submit} onClick={(ev) => ev.stopPropagation()}
        className="card" style={{ width: '100%', maxWidth: 520, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>
            {isNew ? 'Log expense' : 'Edit expense'}
          </h3>
          <button type="button" onClick={onClose} className="btn btn-ghost" style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div className="form-2col">
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              required style={inputSty}/>
          </Field>
          <Field label="Amount ($)">
            <input type="number" min="0.01" step="0.01" value={amount}
              onChange={(e) => setAmount(e.target.value)} required style={inputSty}/>
          </Field>
        </div>

        <Field label="Category" hint="Maps to an IRS Schedule C line.">
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputSty}>
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Vendor">
          <input value={vendor} onChange={(e) => setVendor(e.target.value)}
            placeholder="e.g. Adobe Creative Cloud" style={inputSty}/>
        </Field>

        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            placeholder="Anything that helps remember what this was."
            style={{ ...inputSty, resize: 'vertical', fontFamily: 'inherit' }}/>
        </Field>

        <Field label="Payment method">
          <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} style={inputSty}>
            <option value="card">Card</option>
            <option value="cash">Cash</option>
            <option value="check">Check</option>
            <option value="transfer">Bank transfer</option>
            <option value="other">Other</option>
          </select>
        </Field>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 14 }}>
          <input type="checkbox" checked={isDeductible} onChange={(e) => setIsDeductible(e.target.checked)}/>
          Deductible — include in tax export totals
        </label>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 12,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={onClose} className="btn btn-outline"
            style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}
            style={{ flex: 2, justifyContent: 'center' }}>
            {busy ? 'Saving…' : (isNew ? 'Save expense' : 'Save changes')}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputSty = {
  width: '100%', padding: '8px 10px', borderRadius: 8,
  border: '1px solid var(--border-strong)', background: 'var(--surface)',
  color: 'var(--fg)', fontSize: 13, fontFamily: 'inherit',
};

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
