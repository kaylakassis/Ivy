// Owner-side quotes/estimates manager. Mirrors the invoice list +
// editor patterns intentionally - quotes are structurally invoices
// with a different lifecycle (draft → sent → accepted/declined →
// optional auto-invoice).
import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';

const STATUS_META = {
  draft:    { label: 'Draft',    color: 'var(--muted)' },
  sent:     { label: 'Sent',     color: 'var(--warn)' },
  accepted: { label: 'Accepted', color: 'var(--ok)' },
  declined: { label: 'Declined', color: 'var(--danger)' },
  expired:  { label: 'Expired',  color: 'var(--muted-2)' },
  voided:   { label: 'Voided',   color: 'var(--muted-2)' },
};

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Quotes() {
  const [quotes, setQuotes] = useState(null);
  const [error, setError]   = useState(null);
  const [editing, setEditing] = useState(null); // 'new' | quote
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const r = await api.get('/quotes');
    setQuotes(r.quotes || []);
  };

  useEffect(() => {
    let live = true;
    refresh().catch((e) => live && setError(e));
    return () => { live = false; };
  }, []);

  // Cmd+K palette deep-link: /finance?quote=<id> → open that quote
  // for edit. Requires the list to be loaded so we can find the row.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const quoteId = params.get('quote');
    if (!quoteId || !Array.isArray(quotes)) return;
    const found = quotes.find((q) => q.id === quoteId);
    if (found) setEditing(found);
    // Strip the param regardless - missing-quote case is a no-op,
    // but leaving the URL param would re-fire the effect on every
    // quotes refresh.
    params.delete('quote');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, quotes]);

  if (quotes === null && !error) {
    return <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading estimates…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '12px 16px', borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5,
      }}>
        <Icons.Receipt size={14} stroke="var(--accent)"/>
        <span style={{ flex: 1, minWidth: 240 }}>
          Estimates let clients approve a price before any invoice is issued. When they accept, the matching invoice drafts itself automatically.
        </span>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icons.Plus size={13}/> New estimate
        </button>
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 13,
        }}>{error.message || 'Could not load estimates.'}</div>
      )}

      {quotes && quotes.length === 0 ? (
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote icon="Receipt"
            title="No estimates yet"
            hint="Send an itemized price to a prospect; if they accept, you get a draft invoice ready to go."/>
        </div>
      ) : (
        <div className="card table-scroll" style={{ overflow: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '110px 2fr 110px 120px 120px 130px 40px',
            padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <div>Number</div><div>Client</div><div>Status</div><div>Issued</div><div>Expires</div>
            <div style={{ textAlign: 'right' }}>Total</div><div/>
          </div>
          {(quotes || []).map((q, i) => {
            const meta = STATUS_META[q.status] || STATUS_META.draft;
            return (
              <div key={q.id} onClick={() => setEditing(q)}
                style={{
                  display: 'grid', gridTemplateColumns: '110px 2fr 110px 120px 120px 130px 40px',
                  padding: '14px 20px', alignItems: 'center', cursor: 'pointer',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                <div className="mono-num" style={{ fontSize: 13, fontWeight: 600 }}>{q.number}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {q.clientName || <span style={{ color: 'var(--muted-2)' }}>No client yet</span>}
                  </div>
                </div>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 99,
                  fontSize: 11, fontWeight: 600, justifySelf: 'flex-start',
                  background: 'var(--surface-2)', border: '1px solid var(--border)', color: meta.color,
                }}>
                  <span style={{ width: 5, height: 5, borderRadius: 99, background: meta.color }}/>{meta.label}
                </span>
                <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                  {q.issueDate ? new Date(q.issueDate).toLocaleDateString() : '-'}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  {q.expiryDate ? new Date(q.expiryDate).toLocaleDateString() : 'No expiry'}
                </div>
                <div className="mono-num" style={{ textAlign: 'right', fontSize: 14, fontWeight: 600 }}>
                  {fmtMoney(q.total)}
                </div>
                <Icons.Arrow size={13} stroke="var(--muted)"/>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <QuoteEditor
          quote={editing === 'new' ? null : editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onChanged={async () => { await refresh(); setEditing(null); }}
          setBusy={setBusy}/>
      )}
    </div>
  );
}

function QuoteEditor({ quote, onClose, onChanged, setBusy, busy }) {
  const isNew = !quote;
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState(quote?.clientId || '');
  const [items, setItems] = useState(() =>
    quote?.items?.length
      ? quote.items.map((it) => ({ ...it }))
      : [{ id: 'li1', description: '', quantity: 1, rate: 0 }]);
  const [taxRate, setTaxRate] = useState(quote?.taxRate ?? 0);
  const [discount, setDiscount] = useState(quote?.discount ?? 0);
  const [notes, setNotes] = useState(quote?.notes || '');
  const [issueDate, setIssueDate] = useState(quote?.issueDate || new Date().toISOString().slice(0, 10));
  const [expiryDate, setExpiryDate] = useState(quote?.expiryDate || '');
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get('/clients').then((r) => setClients(r.clients || [])).catch(() => {});
  }, []);

  // Count only items included by default (required + default-selected
  // options) so the owner's total preview matches the client's starting view.
  const subtotal = useMemo(() => items
    .filter((it) => (!it.optional && !it.packageGroup) ? true : !!it.selected)
    .reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.rate) || 0), 0), [items]);
  const taxable  = Math.max(0, subtotal - Number(discount || 0));
  const tax      = taxable * (Number(taxRate || 0) / 100);
  const total    = taxable + tax;

  const updateItem = (i, patch) => setItems((xs) => xs.map((it, j) => j === i ? { ...it, ...patch } : it));
  const removeItem = (i) => setItems((xs) => xs.filter((_, j) => j !== i));
  const addItem = () => setItems((xs) => [...xs, { id: `li${Date.now().toString(36)}`, description: '', quantity: 1, rate: 0 }]);

  const save = async (afterSave) => {
    setBusy(true); setErr(null);
    try {
      const payload = {
        clientId: clientId || null,
        items, taxRate: Number(taxRate) || 0, discount: Number(discount) || 0,
        notes: notes || null, issueDate, expiryDate: expiryDate || null,
      };
      if (isNew) {
        const r = await api.post('/quotes', payload);
        if (afterSave) await afterSave(r.quote);
      } else {
        const r = await api.patch('/quotes/' + quote.id, payload);
        if (afterSave) await afterSave(r.quote);
      }
      await onChanged();
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally { setBusy(false); }
  };

  const sendNow = async () => {
    if (!clientId) { setErr('Pick a client to send to.'); return; }
    await save(async (saved) => {
      // Already-sent quotes use the dedicated resend endpoint so the
      // recipient sees "Reminder: ..." in the subject and the activity
      // log records "Resent" rather than another "Sent".
      const path = quote?.status === 'sent' ? '/quotes/resend' : '/quotes/send';
      await api.post(path, { id: saved.id });
    });
  };

  const remove = async () => {
    if (!quote) return;
    if (!window.confirm('Delete this draft estimate?')) return;
    setBusy(true);
    try {
      await api.del('/quotes/' + quote.id);
      await onChanged();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  const isLocked = quote && ['accepted', 'declined', 'expired'].includes(quote.status);
  const canSend = !isLocked && (!quote || quote.status === 'draft' || quote.status === 'sent');

  return (
    <div onClick={busy ? null : onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="scroll" style={{
        width: '100%', maxWidth: 720, background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ flex: 1 }}>
            <div className="metric-label">{isNew ? 'New estimate' : `Estimate ${quote.number}`}</div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--fg-2)', marginTop: 4 }}>
              {quote?.status && (STATUS_META[quote.status]?.label || quote.status)}
              {quote?.resultingInvoiceId && ' · invoice drafted'}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {isLocked && (
            <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--surface-2)',
              border: '1px solid var(--border)', fontSize: 12.5, color: 'var(--muted)' }}>
              <Icons.Lock size={11}/> {quote.status === 'accepted'
                ? 'Accepted - see the resulting invoice in the Invoices tab.'
                : 'Locked.'}
            </div>
          )}

          <Field label="Client">
            <select value={clientId} onChange={(e) => setClientId(e.target.value)}
              disabled={isLocked} style={inputS}>
              <option value="">- Select a client -</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.email ? ` · ${c.email}` : ''}
                </option>
              ))}
            </select>
          </Field>

          <div className="form-2col">
            <Field label="Issue date">
              <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)}
                disabled={isLocked} style={inputS}/>
            </Field>
            <Field label="Expiry date (optional)">
              <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)}
                disabled={isLocked} style={inputS}/>
            </Field>
          </div>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <div className="metric-label" style={{ flex: 1 }}>Line items</div>
              {!isLocked && (
                <button className="btn btn-ghost" onClick={addItem} style={{ fontSize: 12, padding: '4px 8px' }}>
                  <Icons.Plus size={11}/> Add line
                </button>
              )}
            </div>
            {items.map((it, i) => {
              const type = it.packageGroup ? 'package' : it.optional ? 'optional' : 'required';
              const setType = (t) => {
                if (t === 'required') updateItem(i, { optional: false, packageGroup: null, selected: true });
                else if (t === 'optional') updateItem(i, { optional: true, packageGroup: null, selected: it.selected ?? false });
                else updateItem(i, { optional: true, packageGroup: it.packageGroup || 'Tier', selected: it.selected ?? false });
              };
              return (
                <div key={it.id || i} style={{
                  padding: 10, marginBottom: 6, borderRadius: 10,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 80px 90px 90px 30px', gap: 8 }}>
                    <input value={it.description}
                      onChange={(e) => updateItem(i, { description: e.target.value })}
                      disabled={isLocked}
                      placeholder="Service / item"
                      style={{ ...inputS, padding: '7px 10px' }}/>
                    <input type="number" min="0" step="0.01"
                      value={it.quantity} onChange={(e) => updateItem(i, { quantity: e.target.value })}
                      disabled={isLocked}
                      style={{ ...inputS, padding: '7px 10px', textAlign: 'right' }}/>
                    <input type="number" min="0" step="0.01"
                      value={it.rate} onChange={(e) => updateItem(i, { rate: e.target.value })}
                      disabled={isLocked}
                      style={{ ...inputS, padding: '7px 10px', textAlign: 'right' }}/>
                    <div className="mono-num" style={{ fontSize: 13, fontWeight: 600,
                      textAlign: 'right', alignSelf: 'center' }}>
                      {fmtMoney((Number(it.quantity) || 0) * (Number(it.rate) || 0))}
                    </div>
                    {!isLocked && (
                      <button className="btn btn-ghost" onClick={() => removeItem(i)}
                        style={{ padding: 4, color: 'var(--danger)' }}>
                        <Icons.X size={13}/>
                      </button>
                    )}
                  </div>
                  {/* Proposal options: make a line required, an optional add-on,
                      or one choice in a package group the client picks from. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <select value={type} onChange={(e) => setType(e.target.value)} disabled={isLocked}
                      style={{ ...inputS, padding: '5px 8px', fontSize: 12, width: 'auto' }}>
                      <option value="required">Required</option>
                      <option value="optional">Optional add-on</option>
                      <option value="package">Package option</option>
                    </select>
                    {type === 'package' && (
                      <input value={it.packageGroup || ''} onChange={(e) => updateItem(i, { packageGroup: e.target.value })}
                        disabled={isLocked} placeholder="Group (e.g. Tier)"
                        style={{ ...inputS, padding: '5px 8px', fontSize: 12, width: 150 }}/>
                    )}
                    {type !== 'required' && (
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--fg-2)' }}>
                        <input type="checkbox" checked={!!it.selected}
                          onChange={() => updateItem(i, { selected: !it.selected })} disabled={isLocked}/>
                        Selected by default
                      </label>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="form-2col">
            <Field label="Tax rate (%)">
              <input type="number" min="0" max="100" step="0.001"
                value={taxRate} onChange={(e) => setTaxRate(e.target.value)}
                disabled={isLocked} style={inputS}/>
            </Field>
            <Field label="Discount ($)">
              <input type="number" min="0" step="0.01"
                value={discount} onChange={(e) => setDiscount(e.target.value)}
                disabled={isLocked} style={inputS}/>
            </Field>
          </div>

          <div style={{ padding: 12, borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            <Row label="Subtotal" value={fmtMoney(subtotal)}/>
            {Number(discount) > 0 && <Row label="Discount" value={`− ${fmtMoney(Number(discount))}`}/>}
            {Number(taxRate) > 0 && <Row label={`Tax (${taxRate}%)`} value={fmtMoney(tax)}/>}
            <Row label="Total" value={fmtMoney(total)} bold/>
          </div>

          <Field label="Notes (optional)">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              disabled={isLocked}
              placeholder="Scope notes, payment terms, etc."
              style={{ ...inputS, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}/>
          </Field>

          {err && (
            <div style={{ padding: '8px 12px', borderRadius: 8,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>
          )}
        </div>

        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center' }}>
          {!isNew && quote.status === 'draft' && !isLocked && (
            <button className="btn btn-ghost" onClick={remove}
              style={{ color: 'var(--danger)' }} disabled={busy}>
              <Icons.Trash size={13}/> Delete
            </button>
          )}
          <div style={{ flex: 1 }}/>
          <button className="btn btn-outline" onClick={onClose} disabled={busy}>Close</button>
          {!isLocked && (
            <button className="btn btn-outline" onClick={() => save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save draft'}
            </button>
          )}
          {canSend && (
            <button className="btn btn-primary" onClick={sendNow} disabled={busy || !clientId}>
              <Icons.Mail size={13}/> {busy ? 'Sending…' : (quote?.status === 'sent' ? 'Resend' : 'Send to client')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: '4px 0', fontSize: bold ? 14.5 : 13,
      fontWeight: bold ? 700 : 500,
      color: bold ? 'var(--fg)' : 'var(--fg-2)',
      borderTop: bold ? '1px solid var(--border)' : 'none',
      paddingTop: bold ? 10 : 4, marginTop: bold ? 6 : 0,
    }}>
      <span>{label}</span><span className="mono-num">{value}</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
    </div>
  );
}

const inputS = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};
