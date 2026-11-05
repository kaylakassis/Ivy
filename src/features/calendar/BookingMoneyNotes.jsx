// Booking details: what happened to the money under the cancellation
// policy (deposit refunded or kept, fee covered by the deposit, a fee the
// card refused and the draft invoice made for it), plus the owner's
// "Refund deposit" button and the "refund the deposit" choice when the
// owner cancels. Owner only: helpers get null money fields and see nothing.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

function heldDeposit(event) {
  const paid = Number(event.depositPaid || 0);
  const refunded = Number(event.depositRefunded || 0);
  return Math.max(0, Math.round((paid - refunded) * 100) / 100);
}

// For the cancel confirmation: "Refund the $25.00 deposit" (on by default).
export function useKeepDeposit(event) {
  const [refund, setRefund] = useState(true);
  const held = heldDeposit(event);
  const control = held > 0 && !event.cancelledAt ? (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5, padding: '6px 2px', cursor: 'pointer' }}>
      <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)}
        style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--accent)' }}/>
      <span>Refund the {usd(held)} deposit to the client. You are cancelling, so no fee is charged.</span>
    </label>
  ) : null;
  return { keepDeposit: held > 0 && !refund, control };
}

export default function BookingMoneyNotes({ event, onBookingChanged }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  if (event.depositPaid == null) return null; // helper view: no money
  const paid = Number(event.depositPaid || 0);
  const refunded = Number(event.depositRefunded || 0);
  const fromDeposit = Number(event.feeFromDeposit || 0);
  const held = heldDeposit(event);
  const refundable = Math.max(0, Math.round((held - fromDeposit) * 100) / 100);
  const lines = [];
  if (paid > 0) lines.push(`Deposit paid: ${usd(paid)}`);
  if (refunded > 0) lines.push(`Deposit refunded: ${usd(refunded)}`);
  if (fromDeposit > 0) {
    lines.push(`${event.feeChargedKind === 'no_show' ? 'No-show' : 'Late-cancel'} fee covered by the deposit: ${usd(fromDeposit)}`);
  }
  if (event.cancelledAt && event.cancelledBy) lines.push(`Cancelled by ${event.cancelledBy === 'client' ? 'the client' : 'you'}`);
  const problems = [];
  if (event.feeChargeError) problems.push(`The fee was not charged: ${event.feeChargeError}${event.feeInvoiceId ? ' A draft invoice for it is waiting in Finance, Invoices.' : ''}`);
  if (event.depositRefundError) problems.push(`The deposit refund did not go through: ${event.depositRefundError}`);
  const canRefund = !!event.cancelledAt && refundable > 0;
  if (!lines.length && !problems.length && !canRefund) return null;

  const refund = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api.post('/calendar/bookings/refund-deposit', { id: event.id });
      if (r.booking) onBookingChanged?.(r.booking);
      setNote(`Refunded ${usd(r.refunded)}.`);
    } catch (e) { setNote(e.message || 'Could not refund'); } finally { setBusy(false); }
  };

  return (
    <div data-testid="booking-money" style={{
      marginTop: 14, padding: '10px 12px', borderRadius: 10, background: 'var(--surface-2)',
      border: '1px solid var(--border)', fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.6,
    }}>
      {lines.map((l) => <div key={l}>{l}</div>)}
      {problems.map((p) => (
        <div key={p} style={{ color: 'var(--danger)', display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 4 }}>
          <Icons.X size={12} sw={2.4} style={{ marginTop: 4, flexShrink: 0 }}/> <span>{p}</span>
        </div>
      ))}
      {canRefund && (
        <button type="button" className="btn btn-outline" onClick={refund} disabled={busy} style={{ marginTop: 8, fontSize: 12 }}>
          {busy ? 'Refunding…' : `Refund ${usd(refundable)} deposit`}
        </button>
      )}
      {note && <div role="status" style={{ marginTop: 6 }}>{note}</div>}
    </div>
  );
}
