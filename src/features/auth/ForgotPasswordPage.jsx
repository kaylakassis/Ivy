// /forgot-password - request a password reset email.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import AuthShell from './AuthShell.jsx';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy]   = useState(false);
  const [sent, setSent]   = useState(false);
  const [err, setErr]     = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (ex) {
      setErr(ex.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <form onSubmit={submit} className="card" style={{
        width: '100%', maxWidth: 420, padding: 32,
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        <Brand />

        <div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 26 }}>Forgot your password?</h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Enter your email and we'll send you a link to set a new one.
          </p>
        </div>

        {sent ? (
          <div style={{
            padding: '12px 14px', borderRadius: 10,
            background: 'var(--accent-soft)', border: '1px solid var(--accent-tint)',
            color: 'var(--accent)', fontSize: 13, lineHeight: 1.5,
          }}>
            <strong>Check your inbox.</strong><br />
            If an account with that email exists, we just sent a reset link. It expires in an hour.
          </div>
        ) : (
          <>
            <Field label="Email">
              <input type="email" required autoFocus value={email}
                onChange={(e) => setEmail(e.target.value)} autoComplete="email" style={inputS} />
            </Field>

            {err && (
              <div style={{
                padding: '8px 12px', borderRadius: 8,
                background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
                color: 'var(--danger)', fontSize: 12.5,
              }}>{err}</div>
            )}

            <button className="btn btn-primary" type="submit" disabled={busy}
              style={{ justifyContent: 'center', padding: '12px 14px', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Sending…' : 'Send reset link'}
              {!busy && <Icons.Arrow size={14} sw={2} />}
            </button>
          </>
        )}

        <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
          Remembered it? <Link to="/signin" style={{ color: 'var(--accent)' }}>Back to sign in</Link>
        </div>
      </form>
    </AuthShell>
  );
}

const inputS = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  border: '1px solid var(--border-strong)', background: 'var(--surface)',
  outline: 'none', fontSize: 14, color: 'var(--fg)',
};
function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 550, color: 'var(--fg-2)' }}>{label}</span>
      {children}
    </label>
  );
}
function Brand() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{
        width: 34, height: 34, borderRadius: 8,
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Logo size={22} color="currentColor" />
      </div>
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em' }}>Ivy OS</div>
        <div className="metric-label" style={{ fontSize: 10, marginTop: 2 }}>All-in-one for solopreneurs</div>
      </div>
    </div>
  );
}
