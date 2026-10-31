// Owner-side gift cards: summary + list of issued cards with running
// balances, and a Refund action per card that was sold online. Issuance
// happens on the public booking page; redemption happens at booking time
// or on the public invoice page via the gift-card code field.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';

function fmtMoney(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const STATUS_META = {
  active:   { label: 'Active',   color: 'var(--ok)' },
  depleted: { label: 'Used up',  color: 'var(--muted-2)' },
  expired:  { label: 'Expired',  color: 'var(--muted-2)' },
  voided:   { label: 'Voided',   color: 'var(--muted-2)' },
};

export default function GiftCards() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // Refund flow: which card is being refunded, the amount (dollars, blank =
  // everything left), a reason, and the request state. Confirm step first,
  // like the invoice editor's.
  const [refundId, setRefundId] = useState(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = () => api.get('/gift-cards').then(setData).catch(setError);
  useEffect(() => {
    let live = true;
    api.get('/gift-cards')
      .then((r) => live && setData(r))
      .catch((e) => live && setError(e));
    return () => { live = false; };
  }, []);

  const startRefund = (c) => { setRefundId(c.id); setRefundAmount(''); setRefundReason(''); setActionErr(null); setNotice(null); };
  const submitRefund = async (c) => {
    setBusy(true); setActionErr(null);
    try {
      const amountCents = refundAmount === '' ? null : Math.round(Number(refundAmount) * 100);
      const r = await api.post('/gift-cards/refund', { id: c.id, amountCents, reason: refundReason || null });
      setNotice(`Refunded ${fmtMoney(r.refund.amountCents)} on the card ending ${c.codeLast4}${r.refund.fullyRefunded ? '; the card is now void.' : '.'}`);
      setRefundId(null);
      await load();
    } catch (e) {
      setActionErr(e.message || 'Refund failed');
    } finally { setBusy(false); }
  };

  if (data === null && !error) {
    return <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading gift cards…</div>;
  }
  if (error) {
    return (
      <div className="card" style={{ padding: 32 }}>
        <EmptyNote icon="Gift" title="Couldn't load gift cards" hint={error.message || 'Try refreshing.'}/>
      </div>
    );
  }
  const { cards, summary } = data;
  const reds = data.redemptions || { bookings: { count: 0 }, invoices: { count: 0 } };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '12px 16px', borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5,
      }}>
        <Icons.Gift size={14} stroke="var(--accent)"/>
        <span style={{ flex: 1, minWidth: 240 }}>
          Gift cards are sold from your public booking page once card payments are connected in Finance. Recipients get the code by email immediately after payment and apply it when they book or when they pay one of your invoices. A refund you issue here (or from your payment dashboard) voids the card, or trims its balance for a partial amount.
        </span>
      </div>
      {notice && <div style={{ fontSize: 12.5, color: 'var(--ok)', padding: '0 4px' }}>{notice}</div>}
      {actionErr && !refundId && <div style={{ fontSize: 12.5, color: 'var(--danger)', padding: '0 4px' }}>{actionErr}</div>}

      {/* Aggregate strip */}
      <div className="grid-auto-sm">
        <Stat label="Issued (lifetime)" value={fmtMoney(summary.issuedCents)} sub={`${summary.total} card${summary.total === 1 ? '' : 's'}`}/>
        <Stat label="Outstanding"      value={fmtMoney(summary.outstandingCents)} sub="Yet to be redeemed" tone={summary.outstandingCents > 0 ? 'warn' : 'muted'}/>
        <Stat label="Redeemed"         value={fmtMoney(summary.redeemedCents)} sub={`${plural(reds.bookings.count, 'booking')} · ${plural(reds.invoices.count, 'invoice')}`}/>
      </div>

      {(!cards || cards.length === 0) ? (
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote icon="Gift"
            title="No gift cards yet"
            hint="When a visitor buys one from your booking page, it'll show up here. The recipient gets the code via email automatically."/>
        </div>
      ) : (
        <div className="card table-scroll" style={{ overflow: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '90px 2fr 110px 110px 130px',
            padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <div>Code</div>
            <div>Recipient</div>
            <div>Status</div>
            <div>Issued</div>
            <div style={{ textAlign: 'right' }}>Balance / Total</div>
          </div>
          {cards.map((c, i) => {
            const meta = STATUS_META[c.status] || STATUS_META.active;
            const refundLeftCents = Math.max(0, c.originalAmountCents - Number(c.refundedCents || 0));
            const refundable = c.paidOnline && c.status !== 'voided' && refundLeftCents > 0;
            const confirming = refundId === c.id;
            return (
              <div key={c.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '90px 2fr 110px 110px 130px',
                padding: '14px 20px', alignItems: 'center',
              }}>
                <div className="mono-num" style={{ fontSize: 12.5, fontWeight: 600 }}>
                  …{c.codeLast4}
                </div>
                <div style={{ minWidth: 0, fontSize: 13 }}>
                  <div style={{ fontWeight: 600 }}>{c.recipientName || '-'}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                    {c.recipientEmail}
                    {c.senderName && ` · From ${c.senderName}`}
                  </div>
                </div>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 99,
                  fontSize: 11, fontWeight: 600, justifySelf: 'flex-start',
                  background: 'var(--surface-2)', border: '1px solid var(--border)', color: meta.color,
                }}>
                  <span style={{ width: 5, height: 5, borderRadius: 99, background: meta.color }}/>{meta.label}
                </span>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {new Date(c.createdAt).toLocaleDateString()}
                </div>
                <div style={{ textAlign: 'right' }} className="mono-num">
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{fmtMoney(c.balanceCents)}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>of {fmtMoney(c.originalAmountCents)}</div>
                  {Number(c.refundedCents) > 0 && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{fmtMoney(c.refundedCents)} refunded</div>}
                </div>
              </div>
              {(refundable || confirming) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 20px 12px', fontSize: 12 }}>
                  {confirming ? (
                    <>
                      <span style={{ color: 'var(--muted)' }}>Refund up to {fmtMoney(refundLeftCents)} to the buyer{c.senderName ? ` (${c.senderName})` : ''}. A full refund voids the card.</span>
                      <input type="number" min="0.01" step="0.01" max={(refundLeftCents / 100).toFixed(2)} value={refundAmount}
                        onChange={(e) => setRefundAmount(e.target.value)} placeholder={(refundLeftCents / 100).toFixed(2)}
                        aria-label="Refund amount" style={{ width: 100, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg)', fontSize: 12 }}/>
                      <select value={refundReason} onChange={(e) => setRefundReason(e.target.value)} aria-label="Refund reason"
                        style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg)', fontSize: 12 }}>
                        <option value="">Reason (optional)</option>
                        <option value="requested_by_customer">Customer requested</option>
                        <option value="duplicate">Charged twice</option>
                        <option value="fraudulent">Fraudulent</option>
                      </select>
                      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setRefundId(null)} style={{ fontSize: 12, padding: '4px 10px' }}>Cancel</button>
                      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => submitRefund(c)} style={{ fontSize: 12, padding: '4px 12px', background: 'var(--danger)' }}>
                        {busy ? 'Refunding…' : (refundAmount && Math.round(Number(refundAmount) * 100) < refundLeftCents ? 'Refund partial' : 'Refund full amount')}
                      </button>
                      {actionErr && <span style={{ color: 'var(--danger)' }}>{actionErr}</span>}
                    </>
                  ) : (
                    <button type="button" className="btn btn-ghost" onClick={() => startRefund(c)} style={{ fontSize: 12, padding: '4px 10px', color: 'var(--danger)', marginLeft: 'auto' }}>
                      Refund{Number(c.refundedCents) > 0 ? ` (${fmtMoney(refundLeftCents)} left)` : ''}
                    </button>
                  )}
                </div>
              )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  const colors = { warn: 'var(--warn)', muted: 'var(--muted)' };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ fontSize: 26, color: tone ? colors[tone] : 'var(--fg)' }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div>
    </div>
  );
}
