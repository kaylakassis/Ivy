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
import InvoiceDocument, { printInvoice } from './InvoiceDocument.jsx';

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
  // "Save this card for future invoices from <business>" on the card
  // checkout. Only offered when the server says the business can keep a
  // card (Stripe, with a client record to attach it to).
  const [saveCard, setSaveCard]   = useState(false);
  // Result of the post-checkout confirm: a card payment is 'paid'; an ACH
  // Direct Debit completes Checkout 'unpaid' and settles later, so the
  // success screen must say "processing", not "paid".
  const [confirmState, setConfirmState] = useState(null); // null | 'paid' | 'processing' | 'unknown'
  // The saved card was declined off-session; offer the normal checkout.
  const [savedCardDeclined, setSavedCardDeclined] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      // Returning from a successful checkout: confirm the payment
      // server-side so the invoice is marked paid (and shows up in the
      // owner's finance tab) immediately - instead of waiting on a webhook
      // that may never have been configured.
      if (paidFlag) {
        try {
          const cr = await fetch('/api/invoice-pay/' + encodeURIComponent(token) + '?action=confirm', {
            method: 'POST', credentials: 'omit',
          });
          const cj = await cr.json().catch(() => ({}));
          if (live) setConfirmState(cj.paid ? 'paid' : (cj.processing ? 'processing' : 'unknown'));
        } catch { if (live) setConfirmState('unknown'); }
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
        body: JSON.stringify({ saveCard: !!(saveCard && inv?.canSaveCard) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) throw new Error(j.error || `HTTP ${r.status}`);
      window.location.href = j.url;
    } catch (e) {
      setPayErr(e.message || 'Could not start payment.');
      setPaying(false);
    }
  };

  // One tap with the card saved for this business. Success lands on the
  // same paid screen as a Checkout return; a bank that wants extra
  // authentication sends us to the normal checkout instead; a decline
  // leaves the regular "Pay with card" button as the way forward.
  const payWithSavedCard = async () => {
    setPaying(true); setPayErr(null);
    try {
      const r = await fetch('/api/invoice-pay/' + encodeURIComponent(token), {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useSavedCard: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 402 || j.code === 'saved_card_declined') {
        setSavedCardDeclined(true);
        setPayErr((j.error || 'Your saved card was declined.') + ' Pay with a different card below.');
        setPaying(false);
        return;
      }
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.url) { window.location.href = j.url; return; }
      if (j.paid) {
        setConfirmState('paid');
        window.location.replace(window.location.pathname + '?paid=1');
        return;
      }
      if (j.processing) {
        setConfirmState('processing');
        window.location.replace(window.location.pathname + '?paid=1');
        return;
      }
      throw new Error('Payment could not be completed.');
    } catch (e) {
      setPayErr(e.message || 'Could not charge the saved card.');
      setPaying(false);
    }
  };

  if (loading) {
    return <PageWrap tweaks={tweaks}><Loader set="client"/></PageWrap>;
  }
  // Post-payment success - render even if the (now-paid) invoice link no
  // longer loads. We confirmed the payment server-side above.
  if (paidFlag) {
    const processing = confirmState === 'processing' || (confirmState !== 'paid' && !!inv?.paymentProcessingAt);
    return (
      <PageWrap tweaks={tweaks}>
        <div className="card" style={{ padding: 36, textAlign: 'center' }}>
          <div style={{
            width: 48, height: 48, borderRadius: 99,
            background: processing ? 'var(--accent)' : 'var(--ok)',
            color: processing ? 'var(--accent-ink)' : '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14,
          }}>{processing ? <Icons.Clock size={24} sw={2.4}/> : <Icons.Check size={24} sw={2.4}/>}</div>
          {processing ? (
            <>
              <div style={{ fontSize: 16, fontWeight: 600 }}>Bank payment started. It usually clears within 4 business days.</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
                {inv?.business?.name || 'The business'} has been told a bank payment is on its way. The invoice is marked paid once the money lands; if your bank returns the payment, we will email you a link to try again.
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 16, fontWeight: 600 }}>Payment received - thank you!</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
                {inv?.business?.name || 'The business'} has been notified and your invoice is marked paid.
              </div>
            </>
          )}
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
  const savedCard = inv.savedCard && inv.savedCard.last4 ? inv.savedCard : null;
  const savedCardLabel = savedCard
    ? `${capitalize(savedCard.brand) || 'Card'} \u2022\u2022\u2022\u2022 ${savedCard.last4}`
    : null;
  const bankProcessing = !!inv.paymentProcessingAt;

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
      {/* The invoice itself: same renderer as the owner's preview and the
          PDF, in the business's own design. */}
      <div className="print-hide" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div>
          <div className="metric-label">Invoice from</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{inv.business?.name || 'An Ivy business'}</div>
        </div>
        <button type="button" onClick={printInvoice} className="btn btn-outline" title="Print or save as PDF" style={{ padding: '6px 12px', fontSize: 12, gap: 6 }}>
          <Icons.Doc size={12}/> Print / PDF
        </button>
      </div>
      <InvoiceDocument invoice={inv} business={inv.business}/>

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
        ) : bankProcessing ? (
          <div>
            <div style={{
              width: 44, height: 44, borderRadius: 99, background: 'var(--accent)', color: 'var(--accent-ink)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12,
            }}><Icons.Clock size={22} sw={2.4}/></div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Bank payment started. It usually clears within 4 business days.</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Nothing more to do. {businessName} will see this invoice as paid once the money lands.
            </div>
          </div>
        ) : showClaimThanks ? (
          thanksBlock
        ) : inv.paymentEnabled ? (
          <>
            {savedCard && !savedCardDeclined && (
              <div style={{ marginBottom: 16 }}>
                <button className="btn btn-primary" onClick={payWithSavedCard} disabled={paying}
                  style={{ padding: '12px 22px', minWidth: 220, justifyContent: 'center' }}>
                  {paying ? 'Charging…' : `Pay ${fmtMoney(remaining)} with ${savedCardLabel}`}
                  {!paying && <Icons.Check size={14} sw={2.2}/>}
                </button>
                <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--muted)' }}>
                  The card you saved with {businessName}. Remove it any time from your portal under Profile.
                </div>
              </div>
            )}
            <div style={{ fontSize: 13.5, color: 'var(--fg-2)', marginBottom: 12, lineHeight: 1.55 }}>
              {savedCard && !savedCardDeclined ? 'Or pay ' : 'Pay '}<strong>{fmtMoney(remaining)}</strong> by card.
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
            <button className={savedCard && !savedCardDeclined ? 'btn btn-outline' : 'btn btn-primary'} onClick={payWithCard} disabled={paying}
              style={{ padding: '12px 22px', minWidth: 220, justifyContent: 'center' }}>
              {paying ? 'Redirecting…' : `Pay ${fmtMoney(remaining)} with ${savedCard && !savedCardDeclined ? 'another card' : 'card'}`}
              {!paying && <Icons.Arrow size={14} sw={2.2}/>}
            </button>
            {inv.canSaveCard && (
              <label style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'center',
                marginTop: 12, fontSize: 12.5, color: 'var(--fg-2)', cursor: 'pointer', textAlign: 'left',
              }}>
                <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)}
                  style={{ marginTop: 2 }}/>
                <span>
                  {savedCard ? 'Replace my saved card with the one I use at checkout' : `Save this card for future invoices from ${businessName}`}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    Stored securely by the payment processor. Only {businessName} can charge it, and you can remove it from your portal at any time.
                  </span>
                </span>
              </label>
            )}
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

function capitalize(s) {
  if (!s) return s;
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
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
