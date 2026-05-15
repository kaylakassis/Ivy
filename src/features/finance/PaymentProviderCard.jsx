// Multi-processor payment settings card. Replaces the Stripe-only
// connect card with a row of three providers (Stripe / Square /
// PayPal) — each with its own Connect button + status. Owners pick
// which one is the active processor; only the active one mints the
// public-pay link on invoices + booking deposits.
//
// All three follow the same flow:
//   • Owner clicks "Connect" → server endpoint redirects them to the
//     provider's hosted onboarding.
//   • Provider redirects back to /api/finance/<provider>-{oauth,onboard}-callback
//     which persists the merchant id + (for Square) tokens.
//   • This card refetches and shows "Connected" with a Disconnect.
//
// "Make active" is the second action — refuses to flip until the
// target provider is connected. Server enforces the same rule.
import React, { useEffect, useState, useCallback } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function PaymentProviderCard() {
  const [data, setData] = useState(null);
  const [err, setErr]   = useState(null);
  const [busy, setBusy] = useState(null); // 'stripe-connect' | 'square-connect' | 'paypal-connect' | 'switch'

  const refresh = useCallback(async () => {
    try {
      const r = await api.get('/finance/payment-providers');
      setData(r);
    } catch (e) {
      setErr(e.message || 'Could not load payment settings');
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Surface the ?stripe / ?square / ?paypal flags from OAuth callbacks
  // so the user gets immediate feedback on the connect attempt. The
  // callback uses `detail` (Stripe's existing pattern) or `msg`
  // (Square/PayPal); we read both so error reasons surface verbatim
  // instead of the generic "try again."
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const stripeFlag = params.get('stripe');
    const squareFlag = params.get('square');
    const paypalFlag = params.get('paypal');
    if (stripeFlag || squareFlag || paypalFlag) {
      const ok = stripeFlag === 'connected' || squareFlag === 'connected' || paypalFlag === 'connected';
      if (ok) refresh();
      else {
        const reason = params.get('msg') || params.get('detail') || '';
        setErr(reason
          ? `Connect failed — ${reason}`
          : 'Connect failed — try again.');
      }
      // strip the params so a refresh doesn't re-show the banner
      const u = new URL(window.location.href);
      ['stripe', 'square', 'paypal', 'msg', 'detail'].forEach((k) => u.searchParams.delete(k));
      window.history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
    }
  }, [refresh]);

  // While the first fetch is in flight, show a spinner. Once `err` is
  // set, fall through to the main render so the error banner is
  // visible — earlier versions of this file bailed on `!data` BEFORE
  // the error display, leaving the card stuck on "Loading…" forever
  // when /api/finance/payment-providers errored.
  if (!data && !err) {
    return <div className="card" style={{ padding: 20, fontSize: 13, color: 'var(--muted)' }}>Loading payment providers…</div>;
  }

  // Error before we ever got data — render a recoverable error card
  // instead of falling through to the (data-less) provider rows.
  if (!data && err) {
    return (
      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <Icons.Bank size={16} sw={1.7}/>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Payment processor</h3>
        </div>
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5, marginBottom: 10,
        }}>
          Could not load payment settings — {err}
        </div>
        <button className="btn btn-outline" onClick={() => { setErr(null); refresh(); }}
          style={{ fontSize: 12, padding: '6px 12px' }}>
          Try again
        </button>
      </div>
    );
  }

  const switchTo = async (id) => {
    setBusy('switch');
    setErr(null);
    try {
      await api.patch('/finance/payment-providers', { paymentProvider: id });
      await refresh();
    } catch (e) {
      setErr(e.message || 'Could not switch provider');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Icons.Bank size={16} sw={1.7}/>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Payment processor</h3>
      </div>
      <p style={{ margin: '6px 0 16px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        Connect one or more processors. The <strong style={{ color: 'var(--fg-2)' }}>active</strong> one mints
        the pay link on every invoice and booking deposit. Clients pay
        through that processor's hosted checkout.
      </p>

      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 12,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ProviderRow
          id="stripe" label="Stripe"
          description="Cards, Apple Pay, Google Pay. Best for card-on-file + recurring billing."
          provider={data.providers.stripe}
          platformReady={data.platform.stripeReady}
          active={data.active === 'stripe'}
          connectHref="/api/finance/stripe-oauth-init"
          disconnectPath="/finance/stripe-disconnect"
          onSwitch={() => switchTo('stripe')}
          onChanged={refresh}
          busy={busy}
        />
        <ProviderRow
          id="square" label="Square"
          description="Cards + Cash App Pay (US) on Square's hosted checkout."
          provider={data.providers.square}
          platformReady={data.platform.squareReady}
          active={data.active === 'square'}
          connectHref="/api/finance/square-oauth-init"
          disconnectPath="/finance/square-disconnect"
          onSwitch={() => switchTo('square')}
          onChanged={refresh}
          busy={busy}
        />
        <ProviderRow
          id="paypal" label="PayPal"
          description="PayPal balance, cards, and Venmo (US) on PayPal's hosted checkout."
          provider={data.providers.paypal}
          platformReady={data.platform.paypalReady}
          active={data.active === 'paypal'}
          connectHref="/api/finance/paypal-onboard-init"
          disconnectPath="/finance/paypal-disconnect"
          onSwitch={() => switchTo('paypal')}
          onChanged={refresh}
          busy={busy}
          comingSoon
        />
      </div>

      <div style={{
        marginTop: 14, padding: '8px 12px', borderRadius: 8,
        background: 'var(--surface-2)', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.55,
      }}>
        <strong style={{ color: 'var(--fg-2)' }}>v1 limitations:</strong> refunds, saved-card auto-charges
        (no-show / late-cancel fees), and recurring invoices currently
        only work for invoices paid via Stripe. Square + PayPal land
        money in your account but use their own dashboards for refunds
        in v1.
      </div>
    </div>
  );
}

function ProviderRow({
  id, label, description,
  provider, platformReady, active,
  connectHref, disconnectPath,
  onSwitch, onChanged, busy,
  comingSoon = false,
}) {
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnect = async () => {
    if (!confirm(`Disconnect ${label}?`)) return;
    setDisconnecting(true);
    try { await api.post(disconnectPath); await onChanged(); }
    finally { setDisconnecting(false); }
  };
  const connected = !!provider?.connected;

  return (
    <div style={{
      padding: 14, borderRadius: 12,
      border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
      background: active ? 'var(--accent-soft)' : 'var(--surface)',
      display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap',
      opacity: comingSoon ? 0.65 : 1,
    }}>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <strong style={{ fontSize: 13.5, color: 'var(--fg)' }}>{label}</strong>
          {comingSoon && (
            <span style={{
              padding: '2px 7px', borderRadius: 999,
              background: 'var(--surface-2)', color: 'var(--muted)',
              fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
            }}>Coming soon</span>
          )}
          {!comingSoon && active && (
            <span style={{
              padding: '2px 7px', borderRadius: 999,
              background: 'var(--accent)', color: 'var(--accent-ink)',
              fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
            }}>Active</span>
          )}
          {!comingSoon && connected && !active && (
            <span style={{
              padding: '2px 7px', borderRadius: 999,
              background: 'var(--surface-2)', color: 'var(--ok)',
              fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
            }}>Connected</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{description}</div>
        {!comingSoon && connected && provider?.merchantId && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
            {provider.label || label}
            {provider.environment ? ` · ${provider.environment}` : ''}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {comingSoon ? (
          <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}>
            Coming soon
          </span>
        ) : !platformReady ? (
          <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}>
            Not configured on this deploy
          </span>
        ) : !connected ? (
          <a className="btn btn-primary" href={connectHref}
            style={{ fontSize: 12, padding: '6px 14px', textDecoration: 'none' }}>
            Connect
          </a>
        ) : (
          <>
            {!active && (
              <button className="btn btn-outline" onClick={onSwitch} disabled={busy === 'switch'}
                style={{ fontSize: 12, padding: '6px 12px' }}>
                {busy === 'switch' ? 'Saving…' : 'Make active'}
              </button>
            )}
            <button className="btn btn-ghost" onClick={disconnect} disabled={disconnecting}
              style={{ fontSize: 12, padding: '6px 10px', color: 'var(--muted)' }}>
              {disconnecting ? '…' : 'Disconnect'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
