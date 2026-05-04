// Paywall modal — blocks the business app when the workspace's subscription
// isn't active and the trial has ended (or never started).
//
// CTAs:
//   • Start free trial — POSTs /api/billing/start-trial. Idempotent.
//   • Subscribe        — POSTs /api/billing/checkout, then redirects to
//                         the returned Stripe Checkout URL.
//
// Post-checkout: Stripe redirects to /?subscribed=1&session_id=cs_...
// We POST /api/billing/sync to fetch the subscription state directly (so
// the modal dismisses even before the webhook has landed) and fall back
// to polling /api/me if that misses.
//
// The user can always escape to the free client portal — modal is never
// a navigation trap.
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function Paywall({ ctx, onRefresh }) {
  const sub = ctx?.subscription || null;
  const [busy, setBusy]   = useState(null); // 'trial' | 'subscribe' | 'syncing' | null
  const [err, setErr]     = useState(null);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const synced = useRef(false);

  // After Stripe Checkout success, hit /sync to flip the row before the
  // webhook arrives. Only runs once per mount even if the modal re-renders.
  useEffect(() => {
    const subscribed = params.get('subscribed');
    const sessionId  = params.get('session_id');
    if (subscribed !== '1' || !sessionId || synced.current) return;
    synced.current = true;
    setBusy('syncing'); setErr(null);
    (async () => {
      try {
        await api.post('/billing/sync', { sessionId });
        await onRefresh();
      } catch (e) {
        // Webhook will eventually catch up — start a short poll loop.
        await pollForActive(onRefresh, 6, 1500);
      }
      // Clean the success/cancel params so a refresh doesn't re-run sync.
      const next = new URLSearchParams(params);
      next.delete('subscribed');
      next.delete('session_id');
      setParams(next, { replace: true });
      setBusy(null);
    })();
  }, [params, onRefresh, setParams]);

  const cancelled = params.get('subscribed') === 'cancelled';

  const startTrial = async () => {
    setBusy('trial'); setErr(null);
    try {
      await api.post('/billing/start-trial', {});
      await onRefresh();
    } catch (e) {
      setErr(e.message || 'Could not start trial');
    } finally {
      setBusy(null);
    }
  };

  const subscribe = async () => {
    setBusy('subscribe'); setErr(null);
    try {
      const r = await api.post('/billing/checkout', {});
      if (!r.url) throw new Error('No checkout URL returned');
      window.location.href = r.url;
    } catch (e) {
      setErr(e.message || 'Could not start checkout');
      setBusy(null);
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
            {busy === 'syncing' ? 'Confirming your subscription…'
            : wasPaid       ? 'Your subscription has ended'
            : trialExpired  ? 'Your free trial has ended'
            : everTrialed   ? 'Subscribe to continue'
            :                 'Start your 28-day free trial'}
          </h2>
          <p style={{ margin: '8px 0 0', color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.55 }}>
            {busy === 'syncing'
              ? "Stripe just told us payment went through. We're refreshing your account — this usually takes a couple of seconds."
              : "The business app — clients, calendar, invoices, documents, and messaging — needs an active subscription. The client portal is free and stays available either way."}
          </p>
        </div>

        {/* Perks */}
        {busy !== 'syncing' && (
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
        )}

        {cancelled && busy !== 'syncing' && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            color: 'var(--fg-2)', fontSize: 12.5,
          }}>Checkout was cancelled — try again whenever you're ready.</div>
        )}

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        {busy !== 'syncing' && (
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            {!everTrialed && (
              <button onClick={startTrial} disabled={busy != null}
                className="btn btn-outline"
                style={{ flex: 1, justifyContent: 'center', padding: '12px 14px' }}>
                {busy === 'trial' ? 'Starting…' : 'Start 28-day free trial'}
              </button>
            )}
            <button onClick={subscribe} disabled={busy != null}
              className="btn btn-primary"
              style={{ flex: everTrialed ? 1 : 1, justifyContent: 'center', padding: '12px 14px' }}>
              {busy === 'subscribe' ? 'Redirecting…' : 'Subscribe'}
              {busy !== 'subscribe' && <Icons.Arrow size={13} sw={2.2}/>}
            </button>
          </div>
        )}

        {busy !== 'syncing' && (
          <button onClick={() => navigate('/me')}
            className="btn btn-ghost"
            style={{ alignSelf: 'center', fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            Use the free client view instead →
          </button>
        )}
      </div>
    </div>
  );
}

// Refresh + recheck up to `attempts` times. Resolves once isActive becomes
// true or attempts run out — caller decides what to do with the timeout.
async function pollForActive(refresh, attempts, intervalMs) {
  for (let i = 0; i < attempts; i++) {
    const r = await refresh();
    if (r?.subscription?.isActive) return true;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return false;
}
