// Side drawer to edit an invoice (line items, dates, tax, discount, notes).
// Locked when status='paid' or 'voided'.
import React, { useState, useEffect, useMemo } from 'react';
import { Icons } from '../../components/Icons.jsx';
import CollectInPersonModal from './CollectInPersonModal.jsx';
import { useEscapeKey } from '../../lib/useEscapeKey.js';
import { useAnimatedClose } from '../../components/motion/useExitAnimation.js';
import { useSuccessFlash } from '../../components/motion/useSuccessFlash.js';
import { fmtMoney as fmtMoneyShared } from '../../lib/money.js';
import { fireConfetti } from '../../lib/celebrate.js';
import InvoicePreviewModal from './InvoicePreviewModal.jsx';
import { invoiceMoney, invoiceActions, invoiceStatusLine } from '../../lib/invoiceRules.js';

// Labels for paid_method / payment_claimed_method values. Mirrors
// PAID_METHOD_LABELS in api/_lib/finance.js.
const METHOD_LABELS = {
  card: 'card', ach: 'ACH', cash: 'cash', check: 'check', transfer: 'bank transfer',
  zelle: 'Zelle', venmo: 'Venmo', cashapp: 'Cash App', paypal: 'PayPal', other: 'another method',
};
const methodLabel = (m) => METHOD_LABELS[m] || m || 'another method';

export default function InvoiceEditor({ invoice, onClose: onCloseNow, onSave, onSend, onResend, onMarkPaid, onVoid, onDelete, onRefund, onClearClaim, onArchive, onOpenRecurring }) {
  // Slide out (140ms) before the parent unmounts us.
  const { closing, close: onClose } = useAnimatedClose(onCloseNow);
  // "Save draft" pulses green once when the save lands.
  const [saveFlash, flashSaved] = useSuccessFlash();
  const [collectOpen, setCollectOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // "Client says they paid" - set from the public invoice page for Zelle /
  // Venmo / Cash App / cash / check. Owner confirms or clears it here.
  const claim = invoice.paymentClaimedAt && (invoice.status === 'sent' || invoice.status === 'overdue')
    ? { at: invoice.paymentClaimedAt, method: invoice.paymentClaimedMethod || 'other', note: invoice.paymentClaimedNote }
    : null;
  const [claimBusy, setClaimBusy] = useState(null); // 'confirm' | 'clear' | null
  const [notReceivedOpen, setNotReceivedOpen] = useState(false);
  const [notReceivedMsg, setNotReceivedMsg] = useState('');
  // Esc → close the editor, but only when no inner sub-modal owns the
  // keypress (CollectInPersonModal has its own Esc handler).
  useEscapeKey(onClose, !collectOpen);
  // Currency-aware formatter pinned to this invoice. Falls back to
  // USD on legacy rows.
  const fmtMoney = (n) => fmtMoneyShared(n, invoice.currency || 'USD');
  const isLocked = invoice.status === 'paid' || invoice.status === 'voided' || invoice.status === 'refunded';
  const refundedAmount = Number(invoice.refundedAmount || 0);
  // What can still be refunded is what was actually collected (paidAmount),
  // which excludes any gift card credit the client applied - that credit
  // goes back on the card when the invoice is refunded.
  const refundBasis = invoice.paidAmount != null ? Number(invoice.paidAmount) : Number(invoice.total || 0);
  const remaining = Math.max(0, refundBasis - refundedAmount);
  const giftCredit = Number(invoice.giftCardCreditCents || 0) / 100;
  const giftRestored = Number(invoice.giftCardCreditRestoredCents || 0) / 100;
  // Which actions the server will accept right now (src/lib/invoiceRules.js).
  // The server sends `allowed`; older payloads fall back to the same rules.
  const allowed = invoice.allowed || invoiceActions(invoice);
  const money = invoice.money || invoiceMoney(invoice);
  const statusLine = invoiceStatusLine(invoice);
  const refundable = !!allowed.refund?.ok && remaining > 0;
  const [notifyVoid, setNotifyVoid] = useState(false);
  const canEmailClient = !!invoice.sentAt && !!invoice.clientEmail;
  const [items, setItems]         = useState(invoice.items || []);
  const [taxRate, setTaxRate]     = useState(invoice.taxRate ?? 0);
  const [discount, setDiscount]   = useState(invoice.discount ?? 0);
  const [issueDate, setIssueDate] = useState(invoice.issueDate || '');
  const [dueDate, setDueDate]     = useState(invoice.dueDate || '');
  const [notes, setNotes]         = useState(invoice.notes || '');
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState(null);
  const [confirm, setConfirm]     = useState(null);  // 'delete' | 'void' | 'paid' | 'refund' | null
  const [notice, setNotice]       = useState(null);  // short "done" line after archive / void
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
      flashSaved();
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} className={`motion-backdrop${closing ? ' is-closing' : ''}`} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 110,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={(e) => e.stopPropagation()} className="scroll motion-drawer" style={{
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

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {claim && (
            <div style={{
              padding: '12px 14px', borderRadius: 10,
              background: 'var(--accent-soft)', border: '1px solid var(--accent)',
              fontSize: 12.5, color: 'var(--fg)', display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200, lineHeight: 1.5 }}>
                  <strong>{invoice.clientName || 'The client'} says they paid by {methodLabel(claim.method)}</strong>
                  {' '}on {new Date(claim.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.
                  {claim.note && <div style={{ color: 'var(--muted)', marginTop: 2 }}>Their note: "{claim.note}"</div>}
                  <div style={{ color: 'var(--muted)', marginTop: 2 }}>
                    Check your {methodLabel(claim.method)} account first. Confirming marks the invoice paid and sends the receipt.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn btn-primary" disabled={!!claimBusy}
                    style={{ fontSize: 12, padding: '6px 12px' }}
                    onClick={async () => {
                      setClaimBusy('confirm'); setErr(null);
                      try { await onMarkPaid(claim.method); fireConfetti(); }
                      catch (e) { setErr(e.message || 'Could not confirm'); }
                      finally { setClaimBusy(null); }
                    }}>
                    {claimBusy === 'confirm' ? 'Confirming…' : 'Confirm payment'}
                  </button>
                  <button className="btn btn-outline" disabled={!!claimBusy}
                    style={{ fontSize: 12, padding: '6px 12px' }}
                    onClick={() => setNotReceivedOpen((v) => !v)}>
                    Not received
                  </button>
                </div>
              </div>
              {notReceivedOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input value={notReceivedMsg} onChange={(e) => setNotReceivedMsg(e.target.value)}
                    placeholder={`Optional message to ${invoice.clientName || 'the client'}, for example: I don't see the ${methodLabel(claim.method)} payment yet. Could you double-check?`}
                    maxLength={1000}
                    style={inputS}/>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button className="btn btn-ghost" disabled={!!claimBusy}
                      style={{ fontSize: 12 }}
                      onClick={() => { setNotReceivedOpen(false); setNotReceivedMsg(''); }}>Cancel</button>
                    <button className="btn btn-outline" disabled={!!claimBusy}
                      style={{ fontSize: 12 }}
                      onClick={async () => {
                        setClaimBusy('clear'); setErr(null);
                        try {
                          await onClearClaim?.(notReceivedMsg.trim() || null);
                          setNotReceivedOpen(false); setNotReceivedMsg('');
                        } catch (e) { setErr(e.message || 'Could not update'); }
                        finally { setClaimBusy(null); }
                      }}>
                      {claimBusy === 'clear' ? 'Updating…' : (notReceivedMsg.trim() ? 'Clear and message client' : 'Clear')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {isLocked && (
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icons.Lock size={13}/>
              <span style={{ flex: 1 }}>
                {invoice.status === 'paid'   && 'Paid - invoice is locked.'}
                {invoice.status === 'voided' && 'Voided - invoice is locked. Restore it to edit or resend.'}
                {invoice.status === 'refunded' && 'Refunded - invoice is locked.'}
                {invoice.archivedAt && ' Archived (hidden from the main list).'}
              </span>
              {invoice.status === 'voided' && (
                <button className="btn btn-outline" disabled={busy}
                  onClick={async () => {
                    setBusy(true); setErr(null);
                    try {
                      // The un-void endpoint accepts exactly { status: 'draft' }.
                      await onSave({ status: 'draft' });
                    } catch (e) { setErr(e.message || 'Restore failed'); }
                    finally { setBusy(false); }
                  }}
                  style={{ fontSize: 12, padding: '5px 10px', flexShrink: 0 }}>
                  Restore to draft
                </button>
              )}
            </div>
          )}

          {invoice.status !== 'draft' && (
            <div data-testid="invoice-money" style={{
              padding: '12px 14px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div data-testid="invoice-status-line" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)' }}>{statusLine}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', fontSize: 12.5, color: 'var(--fg-2)' }}>
                <MoneyBit label="Total" value={fmtMoney(money.total)}/>
                {money.giftCard > 0 && <MoneyBit label="Gift card" value={fmtMoney(money.giftCard)}/>}
                <MoneyBit label="Paid" value={fmtMoney(money.paid)}/>
                {money.refunded > 0 && <MoneyBit label="Refunded" value={fmtMoney(money.refunded)}/>}
                <MoneyBit label="Net" value={fmtMoney(money.net)}/>
                <MoneyBit label="Owed" value={fmtMoney(money.owed)} strong={money.owed > 0}/>
              </div>
            </div>
          )}
          {invoice.fromRecurring && (
            <div data-testid="recurring-note" style={{
              padding: '10px 14px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 12.5, color: 'var(--fg-2)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            }}>
              <Icons.Repeat size={13}/>
              <span style={{ flex: '1 1 200px', lineHeight: 1.5 }}>
                This invoice came from a recurring series. Voiding or deleting it only changes this one; the next invoices still go out.
              </span>
              {onOpenRecurring && (
                <button type="button" className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
                  onClick={() => { onClose(); onOpenRecurring(); }}>
                  Manage the series
                </button>
              )}
            </div>
          )}

          {giftCredit > 0 && (
            <div data-testid="gift-card-applied" style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 12.5, color: 'var(--fg-2)', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Icons.Gift size={13} stroke="var(--accent)"/>
              <span style={{ flex: 1 }}>
                Gift card applied: <strong>${giftCredit.toFixed(2)}</strong>{invoice.giftCardCodeLast4 ? ` (code ending ${invoice.giftCardCodeLast4})` : ''}
                {giftRestored > 0 && <span style={{ color: 'var(--muted)' }}> · ${giftRestored.toFixed(2)} returned to the card</span>}
              </span>
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

        {!confirm && (invoice.status === 'paid' || invoice.status === 'refunded') && (
          <div data-testid="no-delete-hint" style={{ padding: '10px 24px 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Paid and refunded invoices can't be deleted because money moved{allowed.archive?.ok ? ', but you can archive this one to hide it.' : '.'}
            {invoice.status === 'paid' && money.net > 0 ? ' To give money back, use Refund.' : ''}
          </div>
        )}
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
            <>
              <span style={{ fontSize: 12, color: 'var(--fg-2)', width: '100%', lineHeight: 1.5 }}>
                Void this invoice? It stays in your records marked Void, the client's link stops taking payment, and nothing is owed.
              </span>
              {canEmailClient && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, width: '100%', cursor: 'pointer' }}>
                  <input type="checkbox" checked={notifyVoid} onChange={(e) => setNotifyVoid(e.target.checked)}/>
                  Email {invoice.clientName || 'the client'} that it was voided
                </label>
              )}
              <ConfirmRow text=""
                onCancel={() => setConfirm(null)}
                onConfirm={async () => {
                  setBusy(true); setErr(null);
                  try {
                    const r = await onVoid({ notifyClient: canEmailClient && notifyVoid });
                    setConfirm(null);
                    setNotice(r?.clientNotified ? 'Voided. The client was emailed.' : 'Voided. Nothing is owed.');
                  }
                  catch (e) { setErr(e.message || 'Void failed'); }
                  finally { setBusy(false); }
                }}
                busy={busy}/>
            </>
          ) : confirm === 'paid' ? (
            <>
              <select value={paidMethod} onChange={(e) => setPaidMethod(e.target.value)} style={inputS}>
                <option value="card">Card</option>
                <option value="ach">ACH / Bank transfer</option>
                <option value="cash">Cash</option>
                <option value="check">Check</option>
                <option value="zelle">Zelle</option>
                <option value="venmo">Venmo</option>
                <option value="cashapp">Cash App</option>
                <option value="other">Other</option>
              </select>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" disabled={busy}
                onClick={async () => {
                  setBusy(true); setErr(null);
                  try { await onMarkPaid(paidMethod); fireConfetti(); setConfirm(null); }
                  catch (e) { setErr(e.message || 'Mark-paid failed'); }
                  finally { setBusy(false); }
                }}>
                Confirm payment
              </button>
            </>
          ) : confirm === 'refund' ? (
            <>
              {invoice.paidMethod === 'gift_card' && (
                <span style={{ fontSize: 11.5, color: 'var(--muted)', width: '100%', lineHeight: 1.5 }}>
                  This invoice was paid with a gift card, so the refund goes back on the card as credit. No money moves.
                </span>
              )}
              {invoice.paidMethod !== 'cash' && invoice.paidMethod !== 'gift_card' && (
                <span style={{ fontSize: 11.5, color: 'var(--muted)', width: '100%', lineHeight: 1.5 }}>
                  Card fees from the original payment aren't returned by the processor -
                  a full refund costs you the original ~2.9% + 30¢.
                </span>
              )}
              <input type="number" min="0.01" step="0.01" max={remaining}
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                placeholder={remaining.toFixed(2)}
                style={{ ...inputS, width: 110 }}/>
              <select value={refundReason} onChange={(e) => setRefundReason(e.target.value)}
                style={inputS}>
                <option value="">Reason (optional)</option>
                <option value="requested_by_customer">Customer requested</option>
                <option value="duplicate">Charged twice</option>
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
              {allowed.delete?.ok && (
                <button className="btn btn-ghost" onClick={() => setConfirm('delete')}
                  style={{ color: 'var(--danger)' }}>
                  <Icons.Trash size={13}/> Delete
                </button>
              )}
              {allowed.void?.ok && !allowed.delete?.ok && (
                <button className="btn btn-ghost" onClick={() => setConfirm('void')}
                  style={{ color: 'var(--danger)' }}>
                  Void
                </button>
              )}
              {(allowed.archive?.ok || allowed.unarchive?.ok) && onArchive && (
                <button className="btn btn-ghost" data-testid="invoice-archive" disabled={busy}
                  onClick={async () => {
                    setBusy(true); setErr(null);
                    try {
                      const r = await onArchive(!!allowed.archive?.ok);
                      if (r?.changed === 0 && r?.skipped?.length) setErr(r.skipped[0].why);
                      else setNotice(allowed.archive?.ok ? 'Archived. Find it under the Archived filter.' : 'Back in your main list.');
                    } catch (e) { setErr(e.message || 'Could not archive'); }
                    finally { setBusy(false); }
                  }}>
                  <Icons.Folder size={13}/> {allowed.archive?.ok ? 'Archive' : 'Unarchive'}
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
              {!err && notice && <span data-testid="invoice-notice" style={{ fontSize: 11.5, color: 'var(--ok)' }}>{notice}</span>}
              {/* Preview: the invoice and the email exactly as the client
                  gets them. Saves the draft first so the server renders
                  the current line items. */}
              <button className="btn btn-outline" disabled={busy}
                onClick={async () => { if (!isLocked) await save(); setPreviewOpen(true); }}>
                <Icons.Eye size={13}/> Preview
              </button>
              {!isLocked && (
                <>
                  <button className={`btn btn-outline ${saveFlash}`} onClick={save} disabled={busy}>
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
                      // Resend bypasses the "pick a recipient" modal - recipient
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
      {previewOpen && (
        <InvoicePreviewModal
          invoiceId={invoice.id}
          draft={{ items, taxRate: Number(taxRate), discount: Number(discount), issueDate, dueDate: dueDate || null, notes }}
          onClose={() => setPreviewOpen(false)}
          sendLabel={invoice.status === 'sent' || invoice.status === 'overdue' ? 'Resend' : 'Send invoice'}
          onSend={isLocked ? null : async () => {
            setPreviewOpen(false);
            const alreadySent = invoice.status === 'sent' || invoice.status === 'overdue';
            if (alreadySent && onResend) await onResend(); else onSend();
          }}
        />
      )}
    </div>
  );
}

function MoneyBit({ label, value, strong }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>{' '}
      <span className="mono-num" style={{ fontWeight: strong ? 700 : 600, color: strong ? 'var(--fg)' : 'inherit' }}>{value}</span>
    </span>
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

// Bound to the invoice's currency at render time. The render-scope
// fmtMoney is a local const that pulls invoice.currency from its
// closure (see InvoiceEditor body).

const inputS = {
  width: '100%', padding: '8px 12px', borderRadius: 8,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 13, outline: 'none',
};
