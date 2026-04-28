// /reset-password?token=... — submit new password using a one-time token.
import React, { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import { api } from '../../lib/api.js';

export default function ResetPasswordPage() {
  const [tweaks] = useTweaks();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (password !== confirm) {
      setErr('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      nav('/', { replace: true });  // they're now signed in
    } catch (ex) {
      setErr(ex.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <form onSubmit={submit} className="card" style={{
        width: '100%', maxWidth: 420, padding: 32,
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        <Brand />

        <div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 26 }}>Set a new password</h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Pick something at least 8 characters long.
          </p>
        </div>

        {!token && (
          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>
            Missing reset token in URL. Open the link from your email again, or <Link to="/forgot-password" style={{ color: 'var(--danger)', textDecoration: 'underline' }}>request a new one</Link>.
          </div>
        )}

        <Field label="New password">
          <input type="password" required minLength={8} value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" style={inputS} />
        </Field>
        <Field label="Confirm password">
          <input type="password" required minLength={8} value={confirm}
            onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" style={inputS} />
        </Field>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy || !token}
          style={{ justifyContent: 'center', padding: '12px 14px', opacity: (busy || !token) ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Save new password'}
          {!busy && <Icons.Arrow size={14} sw={2} />}
        </button>

        <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
          <Link to="/signin" style={{ color: 'var(--accent)' }}>Back to sign in</Link>
        </div>
      </form>
    </div>
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
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em' }}>thryve</div>
        <div className="metric-label" style={{ fontSize: 10, marginTop: 2 }}>Business OS</div>
      </div>
    </div>
  );
}
