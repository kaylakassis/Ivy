// Stripe connection panel on the Finance page.
//   • Loads /api/finance/stripe-status on mount.
//   • Disconnected: primary CTA initiates Stripe Connect OAuth (one
//     click → Stripe → back). Secondary "Advanced: paste keys manually"
//     link expands the legacy form for users who'd rather use a
//     restricted API key + manual webhook setup.
//   • Connected: shows the linked account label and a Disconnect option.
//
// On return from OAuth, the callback redirects to /finance?stripe=… so
// we surface a toast (connected | declined | error) inline.
import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function StripeConnectCard() {
  const [status, setStatus] = useState(null); // null = loading
  const [opening, setOpening] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthErr, setOauthErr]   = useState(null);
  const [toast, setToast] = useState(null); // 'connected' | 'declined' | 'error'

  const load = async () => {
    try {
      const s = await api.get('/finance/stripe-status');
      setStatus(s);
    } catch {
      setStatus({ connected: false, error: true });
    }
  };
  useEffect(() => { load(); }, []);

  // OAuth callback drops the user back at /finance?stripe=… — surface
  // a toast and strip the param so a refresh doesn't re-toast.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const flag = params.get('stripe');
    if (!flag) return;
    setToast(flag);
    params.delete('stripe');
    params.delete('detail');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startOauth = () => {
    // The init endpoint is GET + 302-redirect to Stripe-hosted onboarding,
    // so we navigate the browser directly. (Account Links flow — Stripe
    // handles the entire onboarding UX.)
    setOauthBusy(true); setOauthErr(null);
    window.location.href = '/api/finance/stripe-oauth-init';
  };

  if (status === null) {
    return (
      <div className="card" style={{ padding: 16, fontSize: 12.5, color: 'var(--muted)' }}>
        Checking Stripe connection…
      </div>
    );
  }

  if (status.connected) {
    return <ConnectedView status={status} onDisconnected={() => load()}/>;
  }

  if (!opening) {
    return (
      <div className="card" style={{
        padding: 18, display: 'flex', flexDirection: 'column', gap: 14,
        background: 'linear-gradient(135deg, var(--accent-soft), transparent)',
        border: '1px solid var(--accent)',
      }}>
        {toast === 'declined' && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
            background: 'var(--surface-2)', color: 'var(--fg-2)',
          }}>
            Stripe sign-in cancelled. Try again whenever you're ready.
          </div>
        )}
        {toast === 'error' && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)',
          }}>
            Something went wrong connecting Stripe. Try the manual key flow if it keeps failing.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'var(--accent)', color: 'var(--accent-ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}><Icons.Dollar size={18}/></div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Accept card payments</div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginTop: 2 }}>
              Sign into Stripe in one click — no API keys to copy. Funds go
              straight to your Stripe; we never hold money.
            </div>
          </div>
          <button onClick={startOauth} disabled={oauthBusy} className="btn btn-primary">
            {oauthBusy ? 'Opening…' : 'Connect with Stripe'}
            <Icons.Arrow size={12} sw={2}/>
          </button>
        </div>

        {oauthErr && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, fontSize: 12,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)',
          }}>
            {oauthErr}
          </div>
        )}

        <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'center' }}>
          {' '}
          <button type="button" onClick={() => setOpening(true)}
            style={{
              background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
              color: 'var(--muted)', textDecoration: 'underline', fontSize: 11.5,
            }}>
            Or paste API keys manually
          </button>
        </div>
      </div>
    );
  }

  return <ConnectForm onConnected={() => { setOpening(false); load(); }} onCancel={() => setOpening(false)}/>;
}

function ConnectedView({ status, onDisconnected }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [showWebhook, setShowWebhook] = useState(!status.webhookConfigured);
  const [copied, setCopied] = useState(false);

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.post('/finance/stripe-disconnect', {});
      onDisconnected();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const copyUrl = async () => {
    if (!status.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(status.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* noop */ }
  };

  const date = status.connectedAt
    ? new Date(status.connectedAt).toLocaleDateString([], { dateStyle: 'medium' })
    : null;

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: 'var(--ok)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}><Icons.Check size={16} sw={2.4}/></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Stripe connected — {status.accountLabel || 'your account'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            {date && <>Connected {date} · </>}
            {status.webhookConfigured ? 'Webhook signing configured' : (
              <span style={{ color: 'var(--warn)' }}>
                Webhook signing not set — paid invoices won't auto-mark
              </span>
            )}
          </div>
        </div>
        <button className="btn btn-ghost" onClick={() => setShowWebhook((v) => !v)}
          style={{ color: 'var(--muted)' }}>
          {showWebhook ? 'Hide setup' : 'Webhook URL'}
        </button>
        {confirming ? (
          <>
            <button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-outline" onClick={disconnect} disabled={busy}
              style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
              {busy ? 'Disconnecting…' : 'Confirm disconnect'}
            </button>
          </>
        ) : (
          <button className="btn btn-ghost" onClick={() => setConfirming(true)}
            style={{ color: 'var(--muted)' }}>
            Disconnect
          </button>
        )}
      </div>
      {showWebhook && status.webhookUrl && (
        <div style={{
          marginTop: 12, padding: 10, borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 11.5, color: 'var(--fg-2)', lineHeight: 1.5,
        }}>
          In Stripe → Developers → Webhooks → <em>Add endpoint</em>, paste this URL
          and listen for <code>checkout.session.completed</code>:
          <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
            <code style={{
              flex: 1, padding: '6px 8px', borderRadius: 6,
              background: 'var(--surface)', border: '1px solid var(--border)',
              fontSize: 11.5, overflow: 'auto', whiteSpace: 'nowrap',
            }}>{status.webhookUrl}</code>
            <button onClick={copyUrl} className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 11.5 }}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div style={{ marginTop: 6 }}>
            Then paste the signing secret (<code>whsec_…</code>) in your Connect Stripe form to enable
            auto-mark on paid invoices.
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectForm({ onConnected, onCancel }) {
  const [secretKey,      setSecret]      = useState('');
  const [publishableKey, setPublishable] = useState('');
  const [webhookSecret,  setWebhook]     = useState('');
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/finance/stripe-connect', { secretKey, publishableKey, webhookSecret });
      onConnected();
    } catch (err) {
      setError(err.message || 'Could not connect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <Icons.Dollar size={18} style={{ color: 'var(--accent)' }}/>
        <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Connect Stripe</div>
        <button type="button" onClick={onCancel} className="btn btn-ghost" style={{ padding: 4 }}>
          <Icons.X size={14}/>
        </button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 14, lineHeight: 1.55 }}>
        Paste keys from{' '}
        <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer"
          style={{ color: 'var(--accent)' }}>your Stripe dashboard</a>.
        We'll verify the secret key and store it encrypted.
      </div>

      <Field label="Secret key" hint="Starts with sk_live_ or sk_test_ — required.">
        <input type="password" autoComplete="off" required
          value={secretKey} onChange={(e) => setSecret(e.target.value)}
          placeholder="sk_live_…"
          style={fieldStyle}/>
      </Field>

      <Field label="Publishable key" hint="Starts with pk_… — optional, used by the public pay page.">
        <input type="text" autoComplete="off"
          value={publishableKey} onChange={(e) => setPublishable(e.target.value)}
          placeholder="pk_live_…"
          style={fieldStyle}/>
      </Field>

      <Field label="Webhook signing secret" hint="Starts with whsec_… — required for paid invoices to auto-mark. Add a webhook in Stripe pointing at /api/webhooks/stripe and paste the signing secret here.">
        <input type="password" autoComplete="off"
          value={webhookSecret} onChange={(e) => setWebhook(e.target.value)}
          placeholder="whsec_…"
          style={fieldStyle}/>
      </Field>

      {error && (
        <div style={{
          marginTop: 4, marginBottom: 12, padding: '8px 10px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
        <button type="button" onClick={onCancel} className="btn btn-outline"
          style={{ flex: 1, justifyContent: 'center' }}>
          Cancel
        </button>
        <button type="submit" disabled={busy || !secretKey}
          className="btn btn-primary"
          style={{ flex: 2, justifyContent: 'center', opacity: (busy || !secretKey) ? 0.6 : 1 }}>
          {busy ? 'Verifying…' : 'Connect Stripe'}
        </button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg)' }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
    </label>
  );
}

const fieldStyle = {
  width: '100%', marginTop: 4, padding: '8px 10px', borderRadius: 8,
  border: '1px solid var(--border-strong)',
  background: 'var(--surface-2)', color: 'var(--fg)',
  fontSize: 13, fontFamily: 'inherit', outline: 'none',
};
