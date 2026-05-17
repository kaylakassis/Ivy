// Side drawer to edit an invoice (line items, dates, tax, discount, notes).
// Locked when status='paid' or 'voided'.
import React, { useState, useEffect, useMemo } from 'react';
import { Icons } from '../../components/Icons.jsx';
import CollectInPersonModal from './CollectInPersonModal.jsx';
import { useEscapeKey } from '../../lib/useEscapeKey.js';

export default function InvoiceEditor({ invoice, onClose, onSave, onSend, onResend, onMarkPaid, onVoid, onDelete, onRefund }) {
  const [collectOpen, setCollectOpen] = useState(false);
  // Esc → close the editor, but only when no inner sub-modal owns the
  // keypress (CollectInPersonModal has its own Esc handler).
  useEscapeKey(onClose, !collectOpen);
  const isLocked = invoice.status === 'paid' || invoice.status === 'voided' || invoice.status === 'refunded';
  const refundedAmount = Number(invoice.refundedAmount || 0);
  const remaining = Math.max(0, Number(invoice.total || 0) - refundedAmount);
  const refundable = (invoice.status === 'paid' || invoice.status === 'refunded') && remaining > 0;
  const [items, setItems]         = useState(invoice.items || []);
  const [taxRate, setTaxRate]     = useState(invoice.taxRate ?? 0);
  const [discount, setDiscount]   = useState(invoice.discount ?? 0);
  const [issueDate, setIssueDate] = useState(invoice.issueDate || '');
  const [dueDate, setDueDate]     = useState(invoice.dueDate || '');
  const [notes, setNotes]         = useState(invoice.notes || '');
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState(null);
  const [confirm, setConfirm]     = useState(null);  // 'delete' | 'void' | 'paid' | 'refund' | null
  const [paidMethod, setPaidMethod] = useState('card');
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');

  useEffect(() => {
    setItems(invoice.items || []);
    setTaxRate(invoice.taxRate ?? 0);
    setDiscount(invoice.discount ?? 0);
    setIssueDate(invoice.issueDate || '');
    setDueDate(invoice.dueDate || '');
    setNotes(invoice.notes || '');
  }, [invoice.id]);

  const totals = useMemo(() => {
    const subtotal = items.reduce((s, it) => s + Number(it.quantity || 0) * Number(it.rate || 0), 0);
    const taxable = Math.max(0, subtotal - Number(discount || 0));
    const tax = taxable * (Number(taxRate || 0) / 100);
    return {
      subtotal, tax, total: taxable + tax,
    };
  }, [items, taxRate, discount]);

  const addItem = () => setItems((xs) => [...xs, {
    id: 'li_' + Math.random().toString(36).slice(2, 8),
    description: '', quantity: 1, rate: 0,
  }]);
  const updateItem = (i, patch) => setItems((xs) => xs.map((it, j) => j === i ? { ...it, ...patch } : it));
  const removeItem = (i) => setItems((xs) => xs.filter((_, j) => j !== i));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await onSave({
        items, taxRate: Number(taxRate), discount: Number(discount),
        issueDate, dueDate: dueDate || null, notes,
      });
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 110,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="scroll" style={{
        width: '100%', maxWidth: 720, background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="metric-label">Invoice {invoice.number} · {invoice.status}</div>
            <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}>
              {invoice.clientName || 'No client yet'}
            </div>
            {invoice.clientEmail && (
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{invoice.clientEmail}</div>
            )}
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}><Icons.X size={15}/></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {isLocked && (
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icons.Lock size={13}/>
              {invoice.status === 'paid'   && 'Paid — invoice is locked.'}
              {invoice.status === 'voided' && 'Voided — invoice is locked.'}
            </div>
          )}

          {/* Dates */}
          <div className="form-2col">
            <Field label="Issue date">
              <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)}
                disabled={isLocked} style={inputS}/>
            </Field>
            <Field label="Due date (optional)">
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
                disabled={isLocked} style={inputS}/>
            </Field>
          </div>

          {/* Line items */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <div className="metric-label" style={{ flex: 1 }}>Line items</div>
              {!isLocked && (
                <button className="btn btn-ghost" onClick={addItem} style={{ fontSize: 12, padding: '4px 8px' }}>
                  <Icons.Plus size={12}/> Add line
                </button>
              )}
            </div>
            {items.length === 0 ? (
              <div style={{
                padding: 16, borderRadius: 10, background: 'var(--surface-2)',
                border: '1px dashed var(--border-strong)',
                color: 'var(--muted)', fontSize: 12.5, textAlign: 'center',
              }}>No line items yet.</div>
            ) : (
              <div className="table-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 80px 100px 100px 30px',
                  gap: 8, padding: '6px 4px', fontSize: 10.5, fontWeight: 600,
                  color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
                  minWidth: 480,
                }}>
                  <div>Description</div>
                  <div style={{ textAlign: 'right' }}>Qty</div>
                  <div style={{ textAlign: 'right' }}>Rate</div>
                  <div style={{ textAlign: 'right' }}>Amount</div>
                  <div/>
                </div>
                {items.map((it, i) => (
                  <div key={it.id} style={{
                    display: 'grid', gridTemplateColumns: '1fr 80px 100px 100px 30px',
                    gap: 8, alignItems: 'center',
                    padding: 8, borderRadius: 8, border: '1px solid var(--border)',
                    background: 'var(--surface-2)',
                    minWidth: 480,
                  }}>
                    <input value={it.description}
                      onChange={(e) => updateItem(i, { description: e.target.value })}
                      placeholder="Service / item"
                      disabled={isLocked} style={inputS}/>
                    <input type="number" min={0} step={0.5} value={it.quantity}
                      onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })}
                      disabled={isLocked}
                      style={{ ...inputS, textAlign: 'right' }}/>
                    <input type="number" min={0} step={1} value={it.rate}
                      onChange={(e) => updateItem(i, { rate: Number(e.target.value) })}
                      disabled={isLocked}
                      style={{ ...inputS, textAlign: 'right' }}/>
                    <div className="mono-num" style={{ textAlign: 'right', fontSize: 13, fontWeight: 600 }}>
                      ${(Number(it.quantity || 0) * Number(it.rate || 0)).toFixed(2)}
                    </div>
                    {!isLocked ? (
                      <button className="btn btn-ghost" onClick={() => removeItem(i)} style={{ padding: '8px 10px', minHeight: 36, color: 'var(--danger)' }}>
                        <Icons.X size={13}/>
                      </button>
                    ) : <div/>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Tax + discount */}
          <div className="form-2col">
            <Field label="Tax rate (%)">
              <input type="number" min={0} max={100} step={0.5} value={taxRate}
                onChange={(e) => setTaxRate(Number(e.target.value))}
                disabled={isLocked} style={inputS}/>
            </Field>
            <Field label="Discount ($)">
              <input type="number" min={0} step={1} value={discount}
                onChange={(e) => setDiscount(Number(e.target.value))}
                disabled={isLocked} style={inputS}/>
            </Field>
          </div>

          {/* Totals */}
          <div style={{
            padding: 16, borderRadius: 12,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <Row label="Subtotal" value={fmtMoney(totals.subtotal)}/>
            {discount > 0  && <Row label="Discount" value={'– ' + fmtMoney(discount)}/>}
            {taxRate > 0   && <Row label={`Tax (${taxRate}%)`} value={fmtMoney(totals.tax)}/>}
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }}/>
            <Row label="Total" value={fmtMoney(totals.total)} bold/>
          </div>

          {/* Notes */}
          <Field label="Notes (optional)" hint="Shows on the invoice the client receives.">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
              disabled={isLocked} style={{ ...inputS, fontFamily: 'inherit', resize: 'vertical' }}/>
          </Field>

          {/* Activity */}
          {(invoice.activity || []).length > 0 && (
            <div>
              <div className="metric-label" style={{ marginBottom: 8 }}>Activity</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[...invoice.activity].reverse().map((a, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 12px', borderRadius: 10,
                    background: 'var(--surface-2)', border: '1px solid var(--border)',
                    fontSize: 12.5,
                  }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 99,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      color: a.kind === 'paid' ? 'var(--ok)'
                            : a.kind === 'voided' || a.kind === 'overdue' ? 'var(--danger)'
                            : 'var(--muted)',
                    }}>{a.kind}</span>
                    <span style={{ flex: 1 }}>{a.text}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}>
                      {new Date(a.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        }}>
          {confirm === 'delete' ? (
            <ConfirmRow text="Delete this draft?" onCancel={() => setConfirm(null)}
              onConfirm={async () => {
                setBusy(true); setErr(null);
                try { await onDelete(); }
                catch (e) { setErr(e.message || 'Delete failed'); }
                finally { setBusy(false); }
              }}
              busy={busy}/>
          ) : confirm === 'void' ? (
            <ConfirmRow text="Void this invoice? The view link stops working."
              onCancel={() => setConfirm(null)}
              onConfirm={async () => {
                setBusy(true); setErr(null);
                try { await onVoid(); setConfirm(null); }
                catch (e) { setErr(e.message || 'Void failed'); }
                finally { setBusy(false); }
              }}
              busy={busy}/>
          ) : confirm === 'paid' ? (
            <>
              <select value={paidMethod} onChange={(e) => setPaidMethod(e.target.value)} style={inputS}>
                <option value="card">Card</option>
                <option value="ach">ACH / Bank transfer</option>
                <option value="cash">Cash</option>
                <option value="check">Check</option>
                <option value="other">Other</option>
              </select>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}
                onClick={async () => {
                  setBusy(true); setErr(null);
                  try { await onMarkPaid(paidMethod); setConfirm(null); }
                  catch (e) { setErr(e.message || 'Mark-paid failed'); }
                  finally { setBusy(false); }
                }}>
                Confirm payment
              </button>
            </>
          ) : confirm === 'refund' ? (
            <>
              <input type="number" min="0.01" step="0.01" max={remaining}
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                placeholder={remaining.toFixed(2)}
                style={{ ...inputS, width: 110 }}/>
              <select value={refundReason} onChange={(e) => setRefundReason(e.target.value)}
                style={inputS}>
                <option value="">Reason (optional)</option>
                <option value="requested_by_customer">Customer requested</option>
                <option value="duplicate">Duplicate</option>
                <option value="fraudulent">Fraudulent</option>
              </select>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} style={{ background: 'var(--danger)' }}
                onClick={async () => {
                  setBusy(true); setErr(null);
                  try {
                    const amount = refundAmount === '' ? null : Number(refundAmount);
                    await onRefund({ amount, reason: refundReason || null });
                    setConfirm(null);
                    setRefundAmount('');
                    setRefundReason('');
                  } catch (e) {
                    setErr(e.message || 'Refund failed');
                  } finally { setBusy(false); }
                }}>
                {refundAmount && Number(refundAmount) < remaining ? 'Refund partial' : 'Refund full amount'}
              </button>
            </>
          ) : (
            <>
              {invoice.status === 'draft' && (
                <button className="btn btn-ghost" onClick={() => setConfirm('delete')}
                  style={{ color: 'var(--danger)' }}>
                  <Icons.Trash size={13}/> Delete
                </button>
              )}
              {!isLocked && invoice.status !== 'draft' && (
                <button className="btn btn-ghost" onClick={() => setConfirm('void')}
                  style={{ color: 'var(--danger)' }}>
                  Void
                </button>
              )}
              {refundable && (
                <button className="btn btn-ghost" onClick={() => setConfirm('refund')}
                  style={{ color: 'var(--danger)' }}>
                  <Icons.Arrow size={12} sw={2} style={{ transform: 'rotate(180deg)' }}/>
                  Refund {refundedAmount > 0 ? `(${remaining.toFixed(2)} left)` : ''}
                </button>
              )}
              <div style={{ flex: 1 }}/>
              {err && <span style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</span>}
              {!isLocked && (
                <>
                  <button className="btn btn-outline" onClick={save} disabled={busy}>
                    {busy ? 'Saving…' : 'Save draft'}
                  </button>
                  {invoice.status !== 'paid' && (
                    <button className="btn btn-outline" onClick={() => setConfirm('paid')}>
                      Mark paid
                    </button>
                  )}
                  {invoice.status !== 'paid' && (
                    <button className="btn btn-outline" disabled={busy}
                      onClick={async () => { await save(); setCollectOpen(true); }}
                      title="Show a QR + link the customer can scan to pay on their phone">
                      <Icons.Phone size={13}/> Collect in person
                    </button>
                  )}
                  <button className="btn btn-primary" disabled={busy}
                    onClick={async () => {
                      await save();
                      const alreadySent = invoice.status === 'sent' || invoice.status === 'overdue';
                      // Resend bypasses the "pick a recipient" modal — recipient
                      // is already locked in on the row. Use the dedicated
                      // /resend endpoint when onResend is wired through.
                      if (alreadySent && onResend) {
                        await onResend();
                      } else {
                        onSend();
                      }
                    }}>
                    <Icons.Mail size={13}/>
                    {invoice.status === 'sent' || invoice.status === 'overdue' ? 'Resend' : 'Send invoice'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {collectOpen && (
        <CollectInPersonModal
          invoice={invoice}
          onClose={() => setCollectOpen(false)}
        />
      )}
    </div>
  );
}

function ConfirmRow({ text, onCancel, onConfirm, busy }) {
  return (
    <>
      <span style={{ fontSize: 12, color: 'var(--danger)', flex: 1 }}>{text}</span>
      <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
      <button className="btn btn-primary" disabled={busy}
        style={{ background: 'var(--danger)', color: '#fff' }}
        onClick={onConfirm}>
        {busy ? 'Working…' : 'Confirm'}
      </button>
    </>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Row({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ fontSize: bold ? 14 : 12.5, color: bold ? 'var(--fg)' : 'var(--muted)', fontWeight: bold ? 600 : 400 }}>
        {label}
      </span>
      <span className="mono-num" style={{ fontSize: bold ? 18 : 13, fontWeight: bold ? 600 : 500 }}>{value}</span>
    </div>
  );
}

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const inputS = {
  width: '100%', padding: '8px 12px', borderRadius: 8,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 13, outline: 'none',
};
