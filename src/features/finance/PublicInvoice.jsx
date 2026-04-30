// /invoice/:token — public invoice view (no login required).
// Shows the invoice with line items + total. "I've paid" button records an
// activity entry on the owner's side so they know to reconcile.
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useTweaks } from '../../lib/tweaks.js';

export default function PublicInvoice() {
  const { token } = useParams();
  const [tweaks]  = useTweaks();
  const [inv, setInv]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/invoice-view/' + encodeURIComponent(token), { credentials: 'omit' })
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status });
        }
        return res.json();
      })
      .then((r) => live && setInv(r.invoice))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [token]);

  const markPaid = async () => {
    setSubmitting(true);
    try {
      await fetch('/api/invoice-view/' + encodeURIComponent(token), {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      setSubmitted(true);
    } catch { /* noop */ }
    finally { setSubmitting(false); }
  };

  if (loading) {
    return <PageWrap tweaks={tweaks}><div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div></PageWrap>;
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
          <div style={{ fontSize: 14, fontWeight: 600 }}>{inv.business?.name || 'A THRYVE business'}</div>
        </div>
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
              {inv.issueDate ? new Date(inv.issueDate).toLocaleDateString([], { dateStyle: 'medium' }) : '—'}
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
        <div style={{
          borderRadius: 12, overflow: 'hidden',
          border: '1px solid var(--border)',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 80px 110px 110px',
            padding: '10px 16px', fontSize: 10.5, fontWeight: 600,
            background: 'var(--surface-2)', borderBottom: '1px solid var(--border)',
            color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em',
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
              alignItems: 'center', fontSize: 13,
            }}>
              <div>{it.description || '—'}</div>
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
        {submitted ? (
          <div>
            <div style={{
              width: 44, height: 44, borderRadius: 99, background: 'var(--ok)', color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12,
            }}><Icons.Check size={22} sw={2.4}/></div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Thanks — we'll let {inv.business?.name || 'them'} know.</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              They'll reconcile and mark this invoice paid on their side.
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13.5, color: 'var(--fg-2)', marginBottom: 12, lineHeight: 1.55 }}>
              Online payment isn't enabled on this invoice yet.<br/>
              When you've paid (cash, transfer, etc.), let the sender know with one tap.
            </div>
            <button className="btn btn-primary" onClick={markPaid} disabled={submitting}
              style={{ padding: '12px 22px', minWidth: 200, justifyContent: 'center' }}>
              {submitting ? 'Sending…' : "I've paid this invoice"}
              {!submitting && <Icons.Check size={14} sw={2.2}/>}
            </button>
          </>
        )}
      </div>
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

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
