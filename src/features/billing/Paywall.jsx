// Paywall modal — UNSKIPPABLE hard wall when the workspace's subscription
// isn't active. Replaces the previous soft wall that let owners route to
// /me and keep working in the free client portal.
//
// Affordances (always rendered, in this order):
//   • Subscribe        — POSTs /api/billing/checkout, redirects to Stripe.
//   • Start free trial — only shown for owners who haven't trialed yet.
//   • Manage billing   — POSTs /api/billing/portal, opens Stripe Customer
//                        Portal so a card update or reactivation doesn't
//                        require a second support touch.
//   • Export my data   — anchor GET /api/account/export. The portability
//                        promise: owners can always retrieve their data,
//                        even when locked out of the app.
//   • Log out          — escape that doesn't compromise the wall.
//
// isClient carve-out: an owner who's ALSO a client of another THRYVE
// business gets one labeled link "Go to {business} as a client" → /me.
// Solo owners (isClient === false) get no /me link at all.
//
// Post-checkout: Stripe redirects to /?subscribed=1&session_id=cs_...
// We POST /api/billing/sync to fetch the subscription state directly (so
// the wall drops even before the webhook has landed) and fall back to
// polling /api/me if that misses.
import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function Paywall({ ctx, onRefresh }) {
  const sub = ctx?.subscription || null;
  const [busy, setBusy]   = useState(null); // 'trial' | 'subscribe' | 'portal' | 'logout' | 'syncing' | null
  const [err, setErr]     = useState(null);
  const [params, setParams] = useSearchParams();
  const synced = useRef(false);

  // Owners who are ALSO clients of another business get one labeled link
  // out — the wall stays unskippable from THEIR perspective (they can't
  // dodge it for their own workspace), but their access to other
  // businesses' client portals isn't collateral damage.
  const clientOnlyBusiness = ctx?.isClient && ctx?.memberships?.length
    ? ctx.memberships[0]
    : null;

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

  const openBillingPortal = async () => {
    setBusy('portal'); setErr(null);
    try {
      const r = await api.post('/billing/portal', {});
      if (!r.url) throw new Error('No portal URL returned');
      window.location.href = r.url;
    } catch (e) {
      // Common case: no stripe_customer_id yet (owner never reached
      // checkout). Surface the helpful message rather than the raw error.
      setErr(e.message || 'Could not open billing portal');
      setBusy(null);
    }
  };

  const logout = async () => {
    setBusy('logout'); setErr(null);
    try {
      await api.post('/auth/logout', {});
    } catch {
      // Best-effort: if the logout call fails, still clear locally.
    }
    window.location.href = '/signin';
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
              style={{ flex: 1, justifyContent: 'center', padding: '12px 14px' }}>
              {busy === 'subscribe' ? 'Redirecting…' : 'Subscribe'}
              {busy !== 'subscribe' && <Icons.Arrow size={13} sw={2.2}/>}
            </button>
          </div>
        )}

        {/* Secondary affordances. These are the entire "escape" surface
            under the hard wall: nothing else lets you sidestep into the
            business app. Each is conservative — Manage billing only
            helps if a Stripe customer exists, Export hits an unrelated
            GET endpoint, Log out clears the session. */}
        {busy !== 'syncing' && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', justifyContent: 'center',
            gap: 6, marginTop: 6, fontSize: 12.5,
          }}>
            {/* Only show "Manage billing" if Stripe has a customer for
                this workspace — otherwise the endpoint 400s. */}
            {ctx?.hasBillingRecord && (
              <>
                <button onClick={openBillingPortal} disabled={busy != null}
                  className="btn btn-ghost"
                  style={{ padding: '6px 10px', color: 'var(--muted)' }}>
                  {busy === 'portal' ? 'Opening…' : 'Manage billing'}
                </button>
                <span aria-hidden="true" style={{ color: 'var(--muted-2)' }}>·</span>
              </>
            )}
            {/* Export is a plain GET so a real <a> with download lets
                the browser stream the response straight to disk. */}
            <a href="/api/account/export" download
              className="btn btn-ghost"
              style={{ padding: '6px 10px', color: 'var(--muted)', textDecoration: 'none' }}>
              Export my data
            </a>
            <span aria-hidden="true" style={{ color: 'var(--muted-2)' }}>·</span>
            <button onClick={logout} disabled={busy != null}
              className="btn btn-ghost"
              style={{ padding: '6px 10px', color: 'var(--muted)' }}>
              {busy === 'logout' ? 'Signing out…' : 'Log out'}
            </button>
          </div>
        )}

        {/* isClient carve-out: a single, labeled link to the OTHER
            business's client portal — never a generic /me link, so the
            owner can't dodge their own wall by claiming to be a client
            of themselves. Only renders when /api/me reports memberships
            elsewhere. */}
        {busy !== 'syncing' && clientOnlyBusiness && (
          <a href="/me"
            className="btn btn-ghost"
            style={{
              alignSelf: 'center', fontSize: 12.5, color: 'var(--muted)',
              marginTop: 2, textDecoration: 'none',
            }}>
            Go to {clientOnlyBusiness.businessName} as a client →
          </a>
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
