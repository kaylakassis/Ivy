// /quote/:token (public) — recipient view of an estimate. Shows
// itemized line + totals + accept / decline actions. Branded with
// the workspace's logo + accent color when set.
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useTweaks } from '../../lib/tweaks.js';

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function PublicQuote() {
  const { token } = useParams();
  const [tweaks] = useTweaks();
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState(null);
  const [done, setDone] = useState(null); // 'accepted' | 'declined'
  const [declineReason, setDeclineReason] = useState('');
  const [showDeclineForm, setShowDeclineForm] = useState(false);
  const [resultInvoice, setResultInvoice] = useState(null);
  const [sel, setSel] = useState({}); // proposal option selections: { itemId: bool }

  useEffect(() => {
    let live = true;
    fetch('/api/quote-view/' + encodeURIComponent(token), { credentials: 'omit' })
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { status: res.status });
        }
        return res.json();
      })
      .then((r) => live && setQuote(r.quote))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [token]);

  // Seed option selections from the quote's defaults once it loads.
  useEffect(() => {
    if (!quote?.items) return;
    const init = {};
    for (const it of quote.items) init[it.id] = (it.optional || it.packageGroup) ? !!it.selected : true;
    setSel(init);
  }, [quote]);

  const submit = async (action, reason, selections) => {
    setSubmitting(true); setSubmitErr(null);
    try {
      const res = await fetch('/api/quote-view/' + encodeURIComponent(token), {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason: reason || null, selections: selections || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setDone(action === 'accept' ? 'accepted' : 'declined');
      if (j.invoiceNumber) setResultInvoice(j.invoiceNumber);
    } catch (e) {
      setSubmitErr(e.message || 'Could not submit');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <Wrap tweaks={tweaks}><div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div></Wrap>;
  }
  if (error) {
    return (
      <Wrap tweaks={tweaks}>
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote icon="Receipt" title="This estimate isn't active"
            hint={error.message || 'It may have expired or already been answered.'}/>
        </div>
      </Wrap>
    );
  }
  if (!quote) return null;

  const accent = quote.business?.accentColor || 'var(--accent)';

  if (done) {
    return (
      <Wrap tweaks={tweaks} accent={quote.business?.accentColor}>
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{
            width: 56, height: 56, borderRadius: 99,
            background: done === 'accepted' ? accent : 'var(--surface-2)',
            color: done === 'accepted' ? '#fff' : 'var(--fg-2)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
          }}>
            {done === 'accepted' ? <Icons.Check size={26} sw={2.4}/> : <Icons.X size={26} sw={2}/>}
          </div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 26 }}>
            {done === 'accepted' ? 'Accepted!' : 'Got it.'}
          </h1>
          <p style={{ color: 'var(--muted)', marginTop: 10, fontSize: 14, lineHeight: 1.55, maxWidth: 460, marginInline: 'auto' }}>
            {done === 'accepted'
              ? <>{quote.business?.name || 'The business'} will follow up with the invoice
                {resultInvoice ? ` (${resultInvoice})` : ''}. Thanks for the green light.</>
              : <>{quote.business?.name || 'The business'} has been notified that you declined.</>}
          </p>
        </div>
      </Wrap>
    );
  }

  const items = quote.items || [];
  const isProposal = quote.hasOptions;
  const isInc = (it) => (!it.optional && !it.packageGroup) ? true : !!sel[it.id];
  const r2 = (n) => Math.round(n * 100) / 100;
  const liveSubtotal = items.filter(isInc).reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.rate) || 0), 0);
  const liveTaxable = Math.max(0, liveSubtotal - Number(quote.discount || 0));
  const liveTax = liveTaxable * Number(quote.taxRate || 0) / 100;
  const live = { subtotal: r2(liveSubtotal), tax: r2(liveTax), total: r2(liveTaxable + liveTax) };
  const toggleOpt = (id) => setSel((s) => ({ ...s, [id]: !s[id] }));
  const pickPkg = (group, id) => setSel((s) => {
    const n = { ...s };
    for (const it of items) if (it.packageGroup === group) n[it.id] = (it.id === id);
    return n;
  });
  const buildSelections = () => items
    .filter((it) => it.optional || it.packageGroup)
    .map((it) => ({ id: it.id, selected: !!sel[it.id] }));

  return (
    <Wrap tweaks={tweaks} accent={quote.business?.accentColor}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
        {quote.business?.logoUrl ? (
          <img src={quote.business.logoUrl} alt="" style={{ height: 48, maxWidth: 140, objectFit: 'contain' }}/>
        ) : (
          <div style={{
            width: 44, height: 44, borderRadius: 12, background: accent, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Receipt size={20}/></div>
        )}
        <div>
          <div className="metric-label">Estimate</div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 22 }}>
            {quote.number}{quote.business?.name ? ` · ${quote.business.name}` : ''}
          </h1>
        </div>
      </div>

      <div className="card" style={{ padding: 24, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
          fontSize: 12.5, color: 'var(--muted)', marginBottom: 18 }}>
          <span>For: <b style={{ color: 'var(--fg-2)' }}>{quote.clientName}</b></span>
          <span>Issued: {quote.issueDate ? new Date(quote.issueDate).toLocaleDateString() : '—'}</span>
          {quote.expiryDate && <span>Valid through: {new Date(quote.expiryDate).toLocaleDateString()}</span>}
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th style={{ textAlign: 'left', padding: '8px 0', fontSize: 11, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Item</th>
              <th style={{ textAlign: 'right', padding: '8px 0', fontSize: 11, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', width: 70 }}>Qty</th>
              <th style={{ textAlign: 'right', padding: '8px 0', fontSize: 11, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', width: 90 }}>Rate</th>
              <th style={{ textAlign: 'right', padding: '8px 0', fontSize: 11, fontWeight: 600,
                letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)', width: 100 }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const inc = isInc(it);
              const editable = quote.status === 'sent' && (it.optional || it.packageGroup);
              const amount = inc ? (Number(it.quantity) || 0) * (Number(it.rate) || 0) : 0;
              return (
                <tr key={it.id} style={{ borderBottom: '1px solid var(--border)', opacity: inc ? 1 : 0.5 }}>
                  <td style={{ padding: '10px 0', color: 'var(--fg)' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: editable ? 'pointer' : 'default' }}>
                      {it.packageGroup ? (
                        <input type="radio" name={`grp_${it.packageGroup}`} checked={!!sel[it.id]} disabled={!editable}
                          onChange={() => pickPkg(it.packageGroup, it.id)} style={{ accentColor: accent }}/>
                      ) : it.optional ? (
                        <input type="checkbox" checked={!!sel[it.id]} disabled={!editable}
                          onChange={() => toggleOpt(it.id)} style={{ accentColor: accent }}/>
                      ) : null}
                      <span>
                        {it.description || '—'}
                        {it.packageGroup
                          ? <span style={{ color: 'var(--muted)', fontSize: 11 }}> · choose one</span>
                          : it.optional
                            ? <span style={{ color: 'var(--muted)', fontSize: 11 }}> · add-on</span>
                            : null}
                      </span>
                    </label>
                  </td>
                  <td style={{ padding: '10px 0', textAlign: 'right', color: 'var(--fg-2)' }}>{it.quantity}</td>
                  <td style={{ padding: '10px 0', textAlign: 'right', color: 'var(--fg-2)' }}>{fmtMoney(it.rate)}</td>
                  <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {isProposal && quote.status === 'sent' && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
            Tick the add-ons you want and pick one option per group — your total updates live.
          </div>
        )}

        <div style={{ marginTop: 14, paddingTop: 14, fontSize: 14 }}>
          <Row label="Subtotal" value={fmtMoney(live.subtotal)}/>
          {Number(quote.discount) > 0 && <Row label="Discount" value={`− ${fmtMoney(quote.discount)}`}/>}
          {Number(quote.taxRate) > 0 && <Row label={`Tax (${quote.taxRate}%)`} value={fmtMoney(live.tax)}/>}
          <Row label="Total" value={fmtMoney(live.total)} bold/>
        </div>

        {quote.notes && (
          <div style={{ marginTop: 16, padding: 12, borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
            {quote.notes}
          </div>
        )}
      </div>

      {quote.status === 'sent' ? (
        <div className="card" style={{ padding: 24 }}>
          <div className="metric-label" style={{ marginBottom: 14, textAlign: 'center' }}>
            Ready to move forward?
          </div>
          {submitErr && (
            <div style={{ padding: '8px 12px', borderRadius: 8,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12.5, marginBottom: 14 }}>{submitErr}</div>
          )}
          {!showDeclineForm ? (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={() => setShowDeclineForm(true)} disabled={submitting}
                className="btn btn-outline" style={{ flex: 1, justifyContent: 'center', minWidth: 140 }}>
                Decline
              </button>
              <button onClick={() => submit('accept', null, buildSelections())} disabled={submitting}
                style={{
                  flex: 2, justifyContent: 'center', minWidth: 200,
                  padding: '12px 22px', borderRadius: 10,
                  background: accent, color: '#fff', border: 0,
                  fontSize: 14, fontWeight: 600,
                  cursor: submitting ? 'wait' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                }}>
                <Icons.Check size={14} sw={2.4}/>
                {submitting ? 'Accepting…' : 'Accept estimate'}
              </button>
            </div>
          ) : (
            <div>
              <textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value.slice(0, 500))}
                rows={3} placeholder="Optional — let them know what changed."
                style={{ width: '100%', padding: '10px 12px', borderRadius: 10,
                  background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
                  color: 'var(--fg)', fontSize: 13.5, outline: 'none',
                  fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5, marginBottom: 12 }}/>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowDeclineForm(false)} disabled={submitting}
                  className="btn btn-outline">Back</button>
                <button onClick={() => submit('decline', declineReason.trim())} disabled={submitting}
                  className="btn btn-primary"
                  style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                  {submitting ? 'Recording…' : 'Decline estimate'}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ padding: 20, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
          This estimate is no longer active{quote.status === 'expired' ? ' — it expired' : ''}.
        </div>
      )}
    </Wrap>
  );
}

function Row({ label, value, bold }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: '4px 0', fontSize: bold ? 16 : 13.5,
      fontWeight: bold ? 700 : 500,
      color: bold ? 'var(--fg)' : 'var(--fg-2)',
      borderTop: bold ? '1px solid var(--border)' : 'none',
      paddingTop: bold ? 10 : 4, marginTop: bold ? 6 : 0,
    }}>
      <span>{label}</span><span className="mono-num">{value}</span>
    </div>
  );
}

function Wrap({ tweaks, accent, children }) {
  const styleVars = accent ? { '--accent': accent } : {};
  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', padding: '40px 24px 80px', background: 'var(--page)',
      ...styleVars,
    }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>{children}</div>
    </div>
  );
}
