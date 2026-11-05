// "Deposits to review": cancellations whose deposit the policy refunds,
// waiting for the owner's one tap (Refund / Keep deposit). Nothing is
// refunded until the owner taps Refund. Renders nothing when the list is
// empty, so it can sit on the calendar and in Finance > Services.
// ?depositReview=<bookingId> (the push / email deep link) highlights it.
import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

function money(n, currency = 'USD') {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(n || 0)); } catch { return `$${Number(n || 0).toFixed(2)}`; }
}

export function DepositDecisionButtons({ bookingId, onDone, size = 'normal' }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const decide = async (decision) => {
    if (busy) return;
    setBusy(decision); setErr(null);
    try {
      const r = await api.post('/calendar/bookings/deposit-reviews', { id: bookingId, decision });
      onDone?.(r);
    } catch (e) {
      setErr(e.message || 'Could not save');
    } finally { setBusy(null); }
  };
  const pad = size === 'small' ? '6px 12px' : '8px 14px';
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" onClick={() => decide('refund')} disabled={!!busy} style={{ padding: pad, fontSize: 13 }}>
          {busy === 'refund' ? 'Refunding…' : 'Refund'}
        </button>
        <button type="button" className="btn btn-outline" onClick={() => decide('keep')} disabled={!!busy} style={{ padding: pad, fontSize: 13 }}>
          {busy === 'keep' ? 'Saving…' : 'Keep deposit'}
        </button>
      </div>
      {err && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 6 }}>{err}</div>}
    </div>
  );
}

export default function DepositReviews() {
  const location = useLocation();
  const focus = new URLSearchParams(location.search).get('depositReview');
  const [items, setItems] = useState(null);
  const [done, setDone] = useState({});
  const load = () => api.get('/calendar/bookings/deposit-reviews').then((r) => setItems(r.reviews || [])).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  if (!items || items.length === 0) return null;
  return (
    <div className="card" data-testid="deposit-reviews" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Icons.Dollar size={15}/>
        <div style={{ fontWeight: 650, fontSize: 14.5, flex: 1 }}>Deposits to review</div>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Nothing is refunded until you tap Refund.</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((it) => {
          const first = String(it.clientName || 'Client').trim().split(/\s+/)[0];
          const d = done[it.bookingId];
          return (
            <div key={it.bookingId} style={{
              padding: '10px 12px', borderRadius: 10, background: 'var(--surface-2)',
              border: `1px solid ${focus === it.bookingId ? 'var(--accent)' : 'var(--border)'}`,
            }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.45 }}>
                Refund {first}'s {money(it.amount, it.currency)} deposit? <span style={{ fontWeight: 400, color: 'var(--fg-2)' }}>({it.reason})</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 8px' }}>
                {it.serviceName || 'Appointment'} on {it.date}
              </div>
              {d ? (
                <div role="status" style={{ fontSize: 13, color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icons.Check size={13} sw={2.4}/> {d}
                </div>
              ) : (
                <DepositDecisionButtons bookingId={it.bookingId} size="small" onDone={(r) => setDone((m) => ({
                  ...m, [it.bookingId]: r.kept ? 'Deposit kept.' : r.alreadyDecided ? 'Already decided.' : `Refunded ${money(r.refunded, it.currency)}. ${first} gets a receipt.`,
                }))}/>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
