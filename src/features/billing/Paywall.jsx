// Paywall modal — blocks the business app when the workspace's subscription
// isn't active and the trial has ended (or never started).
//
// Two CTAs:
//   • Start free trial — POSTs /api/billing/start-trial. Idempotent on the
//     server. Refreshes the user-context so AppShell unblocks.
//   • Subscribe — stub for now (real Stripe billing wiring is the next
//     commit). Surfaces a "coming soon" note instead of pretending to work.
//
// The user can always escape to the free client portal — the modal is not
// a navigation trap. We render the existing ViewToggle below the card.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function Paywall({ ctx, onRefresh }) {
  const sub = ctx?.subscription || null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [subInfo, setSubInfo] = useState(false);
  const navigate = useNavigate();

  const startTrial = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/billing/start-trial', {});
      await onRefresh();
    } catch (e) {
      setErr(e.message || 'Could not start trial');
    } finally {
      setBusy(false);
    }
  };

  // Distinguish trial-expired from never-trialed so the copy matches.
  const trialExpired = sub?.status === 'trialing' && sub?.daysRemaining === 0;
  const everTrialed  = !!sub?.trialEndsAt;
  const wasPaid      = sub?.status === 'cancelled' || sub?.status === 'past_due';

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="paywall-title" style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(10, 12, 8, 0.55)',
      backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}>
      <div className="card" style={{
        width: '100%', maxWidth: 460, padding: 28,
        display: 'flex', flexDirection: 'column', gap: 14,
        boxShadow: '0 24px 60px rgba(0,0,0,0.25)',
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, alignSelf: 'flex-start',
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Trending size={20}/></div>

        <div>
          <h2 id="paywall-title" style={{
            margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500,
            fontSize: 24, letterSpacing: '-0.02em',
          }}>
            {wasPaid       ? 'Your subscription has ended'
            : trialExpired ? 'Your free trial has ended'
            : everTrialed  ? 'Subscribe to continue'
            :                'Start your 14-day free trial'}
          </h2>
          <p style={{ margin: '8px 0 0', color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.55 }}>
            The business app — clients, calendar, invoices, documents, and
            messaging — needs an active subscription. The client portal is
            free and stays available either way.
          </p>
        </div>

        {/* Perks */}
        <ul style={{
          margin: 0, padding: '4px 0', listStyle: 'none',
          display: 'flex', flexDirection: 'column', gap: 6,
          fontSize: 13, color: 'var(--fg-2)',
        }}>
          {[
            'Unlimited clients, bookings, and invoices',
            'Online card payments through your own Stripe',
            'Documents + e-signature',
            'Messaging with clients in one place',
          ].map((p) => (
            <li key={p} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icons.Check size={13} sw={2.4} stroke="var(--accent)"/> {p}
            </li>
          ))}
        </ul>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        {subInfo && (
          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5,
          }}>
            Card billing isn't wired up yet — we're shipping it next. For now,
            start your free trial and we'll let you know the moment subscriptions
            go live.
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          {!everTrialed && (
            <button onClick={startTrial} disabled={busy}
              className="btn btn-primary"
              style={{ flex: 1, justifyContent: 'center', padding: '12px 14px' }}>
              {busy ? 'Starting…' : 'Start 14-day free trial'}
              {!busy && <Icons.Arrow size={13} sw={2.2}/>}
            </button>
          )}
          <button onClick={() => setSubInfo((v) => !v)}
            className={everTrialed ? 'btn btn-primary' : 'btn btn-outline'}
            style={{ flex: 1, justifyContent: 'center', padding: '12px 14px' }}>
            Subscribe
          </button>
        </div>

        <button onClick={() => navigate('/me')}
          className="btn btn-ghost"
          style={{ alignSelf: 'center', fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          Use the free client view instead →
        </button>
      </div>
    </div>
  );
}
