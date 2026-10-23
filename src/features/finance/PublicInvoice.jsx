// /invoice/:token - public invoice view (no login required).
// Shows the invoice with line items + total. When the issuing workspace has
// a processor wired up (paymentEnabled flag from the API), shows a "Pay with
// card" button that creates a checkout session and redirects. Below that,
// "Other ways to pay" lists the owner's Zelle / Venmo / Cash App / cash /
// check details with an "I've sent it" tap that tells the owner to confirm.
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import Loader from '../../components/motion/Loader.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import { fmtMoney as fmtMoneyShared } from '../../lib/money.js';

const MANUAL_LABELS = { zelle: 'Zelle', venmo: 'Venmo', cashapp: 'Cash App', cash: 'Cash', check: 'Check', other: 'Other' };
const manualLabel = (t) => MANUAL_LABELS[t] || 'Other';

// App deep links for the two methods that have one. Venmo opens the app
// with the recipient, amount and note filled in; Cash App uses its web
// pay link (which hands off to the app on a phone). Zelle has no public
// link scheme, so it is copy-only.
function deepLinkFor(method, amount, invoiceNumber) {
  const handle = String(method.handle || '').trim();
  if (!handle) return null;
  const amt = Number(amount || 0).toFixed(2);
  if (method.type === 'venmo') {
    const user = handle.replace(/^@/, '');
    return {
      href: `venmo://paycharge?txn=pay&recipients=${encodeURIComponent(user)}&amount=${amt}&note=${encodeURIComponent(`Invoice ${invoiceNumber}`)}`,
      label: 'Open Venmo',
    };
  }
  if (method.type === 'cashapp') {
    const tag = handle.replace(/^\$/, '');
    return { href: `https://cash.app/$${encodeURIComponent(tag)}/${amt}`, label: 'Open Cash App' };
  }
  return null;
}

export default function PublicInvoice() {
  const { token } = useParams();
  const [params]  = useSearchParams();
  const [tweaks]  = useTweaks();
  const paidFlag      = params.get('paid') === '1';
  const cancelledFlag = params.get('cancelled') === '1';
  // PayPal return (api/finance/paypal-return.js) reports a failed capture
  // as ?payment=error&msg=<reason>.
  const paymentErrorMsg = params.get('payment') === 'error'
    ? (params.get('msg') || 'Payment could not be completed.').slice(0, 160)
    : null;
  const [inv, setInv]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  // "I've sent it" state. `claimed` holds the method the client told the
  // owner about (from this visit or an earlier one); `submitting` is the
  // method currently posting. `changing` re-opens the per-row buttons so
  // a client who paid a different way can say so.
  const [claimed, setClaimed]       = useState(null);
  const [submitting, setSubmitting] = useState(null);
  const [changing, setChanging]     = useState(false);
  const [markPaidErr, setMarkPaidErr] = useState(null);
  const [copied, setCopied]       = useState(null);
  const [paying, setPaying]       = useState(false);
  const [payErr, setPayErr]       = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      // Returning from a successful checkout: confirm the payment
      // server-side so the invoice is marked paid (and shows up in the
      // owner's finance tab) immediately - instead of waiting on a webhook
      // that may never have been configured.
      if (paidFlag) {
        try {
          await fetch('/api/invoice-pay/' + encodeURIComponent(token) + '?action=confirm', {
            method: 'POST', credentials: 'omit',
          });
        } catch { /* best-effort - the success screen still renders */ }
      }
      try {
        const res = await fetch('/api/invoice-view/' + encodeURIComponent(token), { credentials: 'omit' });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status });
        }
        const r = await res.json();
        if (live) {
          setInv(r.invoice);
          if (r.invoice?.paymentClaimedAt) setClaimed({ method: r.invoice.paymentClaimedMethod || 'other' });
        }
      } catch (e) {
        // After a successful payment the invoice is marked paid and its link
        // is consumed, so invoice-view 404s - that's expected; the paid
        // success screen renders from paidFlag, not from the invoice.
        if (live && !paidFlag) setError(e);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [token, paidFlag]);

  // Tell the owner "I've sent it" by this method. Idempotent on the
  // server; a second tap just updates the method.
  const claim = async (method = 'other') => {
    setSubmitting(method);
    setMarkPaidErr(null);
    try {
      const res = await fetch('/api/invoice-pay/claim', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, method }),
      });
      // Don't claim success on a failed request. The owner never got
      // notified, so telling the payer "thanks" would be a lie.
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setClaimed({ method });
      setChanging(false);
    } catch {
      setMarkPaidErr('Could not notify the sender. Please try again.');
    }
    finally { setSubmitting(null); }
  };

  const copyHandle = async (type, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(type);
      setTimeout(() => setCopied((c) => (c === type ? null : c)), 1600);
    } catch { /* clipboard blocked - the handle is still on screen */ }
  };

  const payWithCard = async () => {
    setPaying(true); setPayErr(null);
    try {
      const r = await fetch('/api/invoice-pay/' + encodeURIComponent(token), {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) throw new Error(j.error || `HTTP ${r.status}`);
      window.location.href = j.url;
    } catch (e) {
      setPayErr(e.message || 'Could not start payment.');
      setPaying(false);
    }
  };

  if (loading) {
    return <PageWrap tweaks={tweaks}><Loader set="client"/></PageWrap>;
  }
  // Post-payment success - render even if the (now-paid) invoice link no
  // longer loads. We confirmed the payment server-side above.
  if (paidFlag) {
    return (
      <PageWrap tweaks={tweaks}>
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <div style={{
            width: 48, height: 48, borderRadius: 99, background: 'var(--ok)', color: '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14,
          }}><Icons.Check size={24} sw={2.4}/></div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Payment received - thank you!</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
            {inv?.business?.name || 'The business'} has been notified and your invoice is marked paid.
          </div>
        </div>
      </PageWrap>
    );
  }
  if (error || !inv) {
    return (
      <PageWrap tweaks={tweaks}>
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote icon="Dollar"
            title="This invoice link isn't active"
            hint={error?.message || 'It may have been voided, paid, or expired.'}/>
        </div>
      </PageWrap>
    );
  }

  // Currency-aware formatter scoped to this invoice. Falls back to
  // USD on legacy rows that predate the invoices.currency column.
  const fmtMoney = makeFmt(inv.currency);
  const remaining = Math.max(0, inv.total - (Number(inv.paidAmount) || 0));
  const manualMethods = Array.isArray(inv.manualMethods) ? inv.manualMethods : [];
  const businessName = inv.business?.name || 'The business';
  const showClaimThanks = !!claimed && !changing;

  const thanksBlock = (
    <div>
      <div style={{
        width: 44, height: 44, borderRadius: 99, background: 'var(--ok)', color: '#fff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12,
      }}><Icons.Check size={22} sw={2.4}/></div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Thanks. {businessName} will confirm and you'll get a receipt.</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        You told them you paid{claimed?.method && claimed.method !== 'other' ? ` by ${manualLabel(claimed.method)}` : ''}.{' '}
        <button onClick={() => setChanging(true)}
          style={{
            background: 'transparent', border: 0, padding: 0,
            color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', fontSize: 12,
          }}>
          Paid a different way?
        </button>
      </div>
    </div>
  );

  return (
    <PageWrap tweaks={tweaks}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginBottom: 24 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Dollar size={20}/></div>
        <div style={{ flex: 1 }}>
          <div className="metric-label">Invoice</div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 26 }}>{inv.number}</h1>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="metric-label" style={{ fontSize: 10 }}>From</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{inv.business?.name || 'An Ivy business'}</div>
        </div>
        {/* Print / Save-as-PDF: triggers the browser's native print
            dialog. On every modern browser "Save as PDF" is a
            destination in that dialog - no client-side PDF library
            needed. Hidden from the printed output itself via the
            print-hide CSS class so the button doesn't appear on the
            generated PDF. */}
        <button
          type="button"
          onClick={() => window.print()}
          className="btn btn-outline print-hide"
          title="Print or save as PDF"
          style={{ padding: '6px 12px', fontSize: 12, gap: 6 }}>
          <Icons.Doc size={12}/> Print / PDF
        </button>
      </div>

      {/* Card */}
      <div className="card" style={{ padding: 36 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
          <div>
            <div className="metric-label">Bill to</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>{inv.clientName}</div>
            {inv.clientEmail && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{inv.clientEmail}</div>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="metric-label">Issued</div>
            <div style={{ fontSize: 14, fontWeight: 500, marginTop: 4 }}>
              {inv.issueDate ? new Date(inv.issueDate).toLocaleDateString([], { dateStyle: 'medium' }) : '-'}
            </div>
            {inv.dueDate && (
              <>
                <div className="metric-label" style={{ marginTop: 8 }}>Due</div>
                <div style={{ fontSize: 14, fontWeight: 500, marginTop: 4 }}>
                  {new Date(inv.dueDate).toLocaleDateString([], { dateStyle: 'medium' })}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Line items */}
        <div className="table-scroll" style={{
          borderRadius: 12, overflow: 'hidden',
          border: '1px solid var(--border)',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 80px 110px 110px',
            padding: '10px 16px', fontSize: 10.5, fontWeight: 600,
            background: 'var(--surface-2)', borderBottom: '1px solid var(--border)',
            color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
            minWidth: 520,
          }}>
            <div>Description</div>
            <div style={{ textAlign: 'right' }}>Qty</div>
            <div style={{ textAlign: 'right' }}>Rate</div>
            <div style={{ textAlign: 'right' }}>Amount</div>
          </div>
          {(inv.items || []).map((it, i) => (
            <div key={it.id || i} style={{
              display: 'grid', gridTemplateColumns: '1fr 80px 110px 110px',
              padding: '12px 16px',
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              minWidth: 520,
              alignItems: 'center', fontSize: 13,
            }}>
              <div>{it.description || '-'}</div>
              <div style={{ textAlign: 'right' }}>{it.quantity}</div>
              <div className="mono-num" style={{ textAlign: 'right' }}>{fmtMoney(it.rate)}</div>
              <div className="mono-num" style={{ textAlign: 'right', fontWeight: 600 }}>
                {fmtMoney(Number(it.quantity || 0) * Number(it.rate || 0))}
              </div>
            </div>
          ))}
        </div>

        {/* Totals */}
        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ minWidth: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Row label="Subtotal" value={fmtMoney(inv.subtotal)}/>
            {inv.discount > 0 && <Row label="Discount" value={'– ' + fmtMoney(inv.discount)}/>}
            {inv.taxRate > 0 && <Row label={`Tax (${inv.taxRate}%)`} value={fmtMoney(inv.tax)}/>}
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }}/>
            <Row label="Total" value={fmtMoney(inv.total)} bold/>
            {Number(inv.paidAmount) > 0 && inv.status !== 'paid' && inv.status !== 'refunded' && (
              <>
                <Row label="Already paid" value={'-' + fmtMoney(inv.paidAmount)}/>
                <Row label="Remaining" value={fmtMoney(Math.max(0, inv.total - inv.paidAmount))} bold/>
              </>
            )}
          </div>
        </div>

        {inv.notes && (
          <div style={{ marginTop: 28, paddingTop: 24, borderTop: '1px solid var(--border)' }}>
            <div className="metric-label" style={{ marginBottom: 8 }}>Notes</div>
            <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {inv.notes}
            </div>
          </div>
        )}
      </div>

      {/* Pay action */}
      <div className="card" style={{ padding: 24, marginTop: 16, textAlign: 'center' }}>
        {paidFlag ? (
          <div>
            <div style={{
              width: 44, height: 44, borderRadius: 99, background: 'var(--ok)', color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12,
            }}><Icons.Check size={22} sw={2.4}/></div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Payment received - thanks!</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              {inv.business?.name || 'The sender'} will get a confirmation as soon as the payment processor confirms the charge.
            </div>
          </div>
        ) : showClaimThanks ? (
          thanksBlock
        ) : inv.paymentEnabled ? (
          <>
            <div style={{ fontSize: 13.5, color: 'var(--fg-2)', marginBottom: 12, lineHeight: 1.55 }}>
              Pay <strong>{fmtMoney(remaining)}</strong> by card.
              You'll be taken to a secure checkout - your card details never touch our servers.
            </div>
            {cancelledFlag && (
              <div style={{
                marginBottom: 12, padding: '6px 10px', borderRadius: 6,
                background: 'var(--surface-2)', color: 'var(--muted)', fontSize: 12,
              }}>
                Payment was cancelled - try again whenever you're ready.
              </div>
            )}
            {paymentErrorMsg && (
              <div style={{
                marginBottom: 12, padding: '6px 10px', borderRadius: 6,
                background: 'rgba(155,44,44,0.08)', color: 'var(--danger)', fontSize: 12,
              }}>
                Payment didn't go through: {paymentErrorMsg} You haven't been charged - try again or pay another way.
              </div>
            )}
            {payErr && (
              <div style={{
                marginBottom: 12, padding: '6px 10px', borderRadius: 6,
                background: 'rgba(155,44,44,0.08)', color: 'var(--danger)', fontSize: 12,
              }}>{payErr}</div>
            )}
            <button className="btn btn-primary" onClick={payWithCard} disabled={paying}
              style={{ padding: '12px 22px', minWidth: 220, justifyContent: 'center' }}>
              {paying ? 'Redirecting…' : `Pay ${fmtMoney(remaining)} with card`}
              {!paying && <Icons.Arrow size={14} sw={2.2}/>}
            </button>
            {manualMethods.length === 0 && (
              <div style={{ marginTop: 14, fontSize: 11, color: 'var(--muted)' }}>
                Already paid by another method?{' '}
                <button onClick={() => claim('other')} disabled={!!submitting}
                  style={{
                    background: 'transparent', border: 0, padding: 0,
                    color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', fontSize: 11,
                  }}>
                  {submitting ? 'Sending…' : 'Let them know'}
                </button>
              </div>
            )}
          </>
        ) : manualMethods.length > 0 ? (
          <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            Card payment isn't set up on this invoice. Pay <strong>{fmtMoney(remaining)}</strong> one
            of the ways below, then tap <strong>I've sent it</strong> so {businessName} knows to look for it.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13.5, color: 'var(--fg-2)', marginBottom: 12, lineHeight: 1.55 }}>
              Online payment isn't enabled on this invoice yet.<br/>
              When you've paid (cash, transfer, etc.), let the sender know with one tap.
            </div>
            <button className="btn btn-primary" onClick={() => claim('other')} disabled={!!submitting}
              style={{ padding: '12px 22px', minWidth: 200, justifyContent: 'center' }}>
              {submitting ? 'Sending…' : "I've paid this invoice"}
              {!submitting && <Icons.Check size={14} sw={2.2}/>}
            </button>
          </>
        )}
        {markPaidErr && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--danger)' }}>{markPaidErr}</div>
        )}
      </div>

      {/* Other ways to pay - the owner's Zelle / Venmo / Cash App / cash /
          check details. Nothing here is processed by Ivy; the client pays
          in that app and taps "I've sent it" so the owner can confirm. */}
      {!paidFlag && manualMethods.length > 0 && (
        <div className="card print-hide" style={{ padding: 24, marginTop: 16 }}>
          <div className="metric-label" style={{ marginBottom: 4 }}>Other ways to pay</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 14 }}>
            {showClaimThanks
              ? `You've told ${businessName} you paid. They'll confirm on their side.`
              : `Send ${fmtMoney(remaining)} to ${businessName} with any of these, then tap I've sent it.`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {manualMethods.map((m) => {
              const link = deepLinkFor(m, remaining, inv.number);
              const isSent = claimed?.method === m.type;
              return (
                <div key={m.type} style={{
                  padding: '12px 14px', borderRadius: 12,
                  border: '1px solid ' + (isSent ? 'var(--ok)' : 'var(--border)'),
                  background: 'var(--surface-2)',
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 160 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{manualLabel(m.type)}</div>
                      {m.handle && (
                        <div className="mono-num" style={{ fontSize: 13, color: 'var(--fg-2)', wordBreak: 'break-all', marginTop: 2 }}>
                          {m.handle}
                        </div>
                      )}
                      {m.note && (
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{m.note}</div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {m.handle && (
                        <button type="button" className="btn btn-outline"
                          onClick={() => copyHandle(m.type, m.handle)}
                          style={{ fontSize: 12, padding: '6px 10px', gap: 6 }}>
                          <Icons.Copy size={12}/> {copied === m.type ? 'Copied' : 'Copy'}
                        </button>
                      )}
                      {link && (
                        <a className="btn btn-outline" href={link.href} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: 12, padding: '6px 10px', textDecoration: 'none' }}>
                          {link.label}
                        </a>
                      )}
                      {isSent && showClaimThanks ? (
                        <span style={{
                          alignSelf: 'center', fontSize: 12, fontWeight: 600, color: 'var(--ok)',
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                        }}><Icons.Check size={12} sw={2.4}/> Sent</span>
                      ) : !showClaimThanks && (
                        <button type="button" className="btn btn-primary"
                          onClick={() => claim(m.type)} disabled={!!submitting}
                          style={{ fontSize: 12, padding: '6px 12px' }}>
                          {submitting === m.type ? 'Sending…' : "I've sent it"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {showClaimThanks && (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
              Thanks. {businessName} will confirm and you'll get a receipt.
            </div>
          )}
        </div>
      )}
    </PageWrap>
  );
}

function Row({ label, value, bold }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ fontSize: bold ? 14 : 12.5, color: bold ? 'var(--fg)' : 'var(--muted)', fontWeight: bold ? 600 : 400 }}>
        {label}
      </span>
      <span className="mono-num" style={{ fontSize: bold ? 22 : 13, fontWeight: bold ? 600 : 500 }}>{value}</span>
    </div>
  );
}

// Local wrapper that pulls the invoice's currency from the closure-
// scoped `inv` object. fmtMoney calls deep inside render trees would
// otherwise need to be re-plumbed to take currency explicitly.
function makeFmt(currency) {
  return (n) => fmtMoneyShared(n, currency || 'USD');
}

function PageWrap({ tweaks, children }) {
  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', padding: '40px 24px 80px', background: 'var(--page)',
    }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>{children}</div>
    </div>
  );
}
