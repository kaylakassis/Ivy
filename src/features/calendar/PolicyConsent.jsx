// Cancellation policy on the booking page.
//
//   usePolicyConsent(cal)  state for the box, the fields to send with the
//                          booking, and recovery when the owner changed or
//                          switched on the policy after the page loaded.
//   <PolicyConsent/>       the owner's policy (expandable) plus, when the
//                          owner switched it on, the required checkbox.
//   <CardOnFilePrompt/>    on the confirmation screen: keep a card on file
//                          when the service has a late-cancel / no-show fee.
//
// A current page ALWAYS sends `policyAccepted` (true/false) with the
// version it showed, so the server can tell it apart from an older app
// that cannot show the box. The owner's text is rendered as React text.
import React, { useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';

function windowLabel(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  if (h % 24 === 0) return `${h / 24} day${h === 24 ? '' : 's'}`;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

function depositFor(svc, total) {
  if (!svc) return 0;
  const price = Number(total ?? svc.price ?? 0);
  const amt = Number(svc.depositAmount || 0);
  if (!price) return 0;
  if (svc.depositType === 'percent') return Math.round(price * Math.min(100, Math.max(0, amt))) / 100;
  if (svc.depositType === 'fixed') return Math.min(price, Math.max(0, amt));
  if (svc.depositType === 'full') return price;
  return 0;
}

// What happens to the deposit, in plain words, from the service settings
// and the owner's "refund deposits" choice.
export function depositRuleLine(svc, policy, total) {
  const dep = depositFor(svc, total);
  if (!(dep > 0)) return null;
  const win = windowLabel(svc.cancellationWindowHours ?? 24);
  if (policy && policy.refundDepositOutsideWindow === false) return 'Your deposit is not refundable.';
  if (!win) return 'If you cancel, your deposit is refunded.';
  const fee = Number(svc.cancellationFeeAmount || 0);
  return `Cancel at least ${win} ahead and your deposit is refunded. Cancel later and the deposit is kept${fee > 0 ? ' and counts toward the late-cancellation fee' : ''}.`;
}

export function usePolicyConsent(cal) {
  const [override, setOverride] = useState(null);
  const [checked, setChecked] = useState(false);
  const [cardUrl, setCardUrl] = useState(null);
  const policy = override || cal?.cancellationPolicy || null;
  const required = !!(policy && policy.requireAcceptance && policy.text);
  return useMemo(() => ({
    policy,
    required,
    checked,
    setChecked,
    ready: !required || checked,
    cardUrl,
    setCardUrl,
    // Spread into the booking POST body.
    fields: () => ({
      policyAccepted: required ? !!checked : false,
      policyVersionId: policy?.versionId || null,
    }),
    // A 400/409 from the server: the owner switched the policy on, or
    // saved a new version, after this page loaded. Show the latest text
    // and ask again. Returns true when the error was about the policy.
    handleError: (e) => {
      const p = e?.details?.policy;
      if (!e?.details?.policyRequired || !p) return false;
      setOverride({ ...(cal?.cancellationPolicy || {}), ...p, requireAcceptance: true });
      setChecked(false);
      return true;
    },
  }), [policy, required, checked, cardUrl, cal]);
}

export default function PolicyConsent({ consent, svc, total, bizName }) {
  const [open, setOpen] = useState(false);
  const p = consent?.policy;
  const depositLine = depositRuleLine(svc, p, total);
  if (!p?.text && !depositLine) return null;
  if (p?.text && !consent.required && p.showOnBookingPage === false && !depositLine) return null;
  const showText = p?.text && (consent.required || p.showOnBookingPage !== false);
  return (
    <div className="pb-policy" style={{
      marginBottom: 14, padding: '10px 12px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.55,
      background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--fg-2)',
    }}>
      <div className="pb-policy-title" style={{ fontWeight: 650, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icons.Lock size={12} sw={1.8}/> Cancellation policy
      </div>
      {depositLine && <div style={{ marginTop: 4 }}>{depositLine}</div>}
      {showText && (
        <>
          <button type="button" className="pb-link-btn" aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            style={{ fontSize: 12.5, background: 'none', border: 0, padding: 0, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer', minHeight: 32 }}>
            {open ? 'Hide the policy' : `Read ${bizName ? `${bizName}'s` : 'the'} cancellation policy`}
          </button>
          {open && (
            <div style={{
              whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflowY: 'auto',
              padding: '10px 12px', margin: '2px 0 6px', borderRadius: 8,
              background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg)',
            }} tabIndex={0} aria-label="Cancellation policy text">
              {p.text}
            </div>
          )}
        </>
      )}
      {consent.required && (
        <label className="pb-check" style={{
          marginTop: 4, display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13.5, color: 'var(--fg)',
          lineHeight: 1.5, cursor: 'pointer', minHeight: 44, padding: '4px 0', fontWeight: 550,
        }}>
          <input type="checkbox" checked={consent.checked} required
            style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0, accentColor: 'var(--accent)' }}
            onChange={(e) => consent.setChecked(e.target.checked)}/>
          <span>I have read and agree to the cancellation policy</span>
        </label>
      )}
    </div>
  );
}

export function CardOnFilePrompt({ url, svc, bizName }) {
  if (!url || !/^https:\/\//.test(url)) return null;
  const fee = Number(svc?.cancellationFeeAmount || 0);
  const noShow = Number(svc?.noShowFeeAmount || 0);
  const parts = [];
  if (fee > 0) parts.push(`a $${fee.toFixed(2)} late-cancellation fee`);
  if (noShow > 0) parts.push(`a $${noShow.toFixed(2)} no-show fee`);
  return (
    <div className="pb-done-card" style={{ textAlign: 'left' }}>
      <div className="metric-label" style={{ marginBottom: 6 }}>Keep a card on file</div>
      <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55, marginBottom: 10 }}>
        {bizName || 'This business'} has {parts.join(' and ') || 'a cancellation fee'}. Add a card on a secure page so it can be charged only if that applies. Nothing is charged now.
      </div>
      <a className="pb-btn outline" href={url}><Icons.Lock size={13}/> Add a card</a>
    </div>
  );
}
