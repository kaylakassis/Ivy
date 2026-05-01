// /reset-password?token=... — submit new password using a one-time token.
import React, { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { PasswordInput } from './AuthPage.jsx';
import AuthShell from './AuthShell.jsx';

export default function ResetPasswordPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState(null);

  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !busy && token && password.length >= 8 && confirm === password;

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) { setErr('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setErr("Passwords don't match"); return; }
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
    <AuthShell>
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
          <PasswordInput value={password} onChange={setPassword}
            required minLength={8} autoComplete="new-password"/>
        </Field>
        <Field label="Confirm password">
          <PasswordInput value={confirm} onChange={setConfirm}
            required minLength={8} autoComplete="new-password" invalid={mismatch}/>
          {mismatch && (
            <span style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 4 }}>
              Passwords don&apos;t match
            </span>
          )}
          {!mismatch && confirm.length > 0 && confirm === password && (
            <span style={{ fontSize: 11.5, color: 'var(--ok)', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icons.Check size={11} sw={2.4}/> Passwords match
            </span>
          )}
        </Field>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <button className="btn btn-primary" type="submit" disabled={!canSubmit}
          style={{ justifyContent: 'center', padding: '12px 14px', opacity: !canSubmit ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Save new password'}
          {!busy && <Icons.Arrow size={14} sw={2} />}
        </button>

        <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
          <Link to="/signin" style={{ color: 'var(--accent)' }}>Back to sign in</Link>
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
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em' }}>thryve</div>
        <div className="metric-label" style={{ fontSize: 10, marginTop: 2 }}>Business OS</div>
      </div>
    </div>
  );
}
