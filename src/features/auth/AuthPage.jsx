// Shared Sign In / Sign Up screen. `mode` prop toggles between them.
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { useTweaks } from '../../lib/tweaks.js';

export default function AuthPage({ mode = 'signin' }) {
  const { signIn, signUp } = useAuth();
  const [tweaks]  = useTweaks();
  const nav       = useNavigate();
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [name,     setName]     = useState('');
  const [busy, setBusy]   = useState(false);
  const [err,  setErr]    = useState(null);

  const isSignUp = mode === 'signup';

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (isSignUp) await signUp(email, password, name || null);
      else          await signIn(email, password);
      nav('/', { replace: true });
    } catch (ex) {
      setErr(ex.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <form onSubmit={submit} className="card" style={{
        width: '100%', maxWidth: 420, padding: 32,
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
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

        <div>
          <h1 className="page-title" style={{ margin: 0, fontSize: 26 }}>
            {isSignUp ? 'Create your account' : 'Welcome back'}
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            {isSignUp
              ? 'Spin up a workspace in a few seconds.'
              : 'Sign in to pick up where you left off.'}
          </p>
        </div>

        {isSignUp && (
          <Field label="Your name (optional)">
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" style={inputS} />
          </Field>
        )}
        <Field label="Email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" style={inputS} />
        </Field>
        <Field label={isSignUp ? 'Password (8+ characters)' : 'Password'}>
          <input type="password" required minLength={isSignUp ? 8 : undefined}
            value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={isSignUp ? 'new-password' : 'current-password'} style={inputS} />
        </Field>
        {!isSignUp && (
          <div style={{ marginTop: -10, textAlign: 'right' }}>
            <Link to="/forgot-password" style={{ fontSize: 12, color: 'var(--muted)' }}>
              Forgot your password?
            </Link>
          </div>
        )}

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <button className="btn btn-primary" type="submit" disabled={busy}
          style={{ justifyContent: 'center', padding: '12px 14px', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Working…' : (isSignUp ? 'Create account' : 'Sign in')}
          {!busy && <Icons.Arrow size={14} sw={2} />}
        </button>

        <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
          {isSignUp ? (
            <>Already have an account? <Link to="/signin" style={{ color: 'var(--accent)' }}>Sign in</Link></>
          ) : (
            <>New here? <Link to="/signup" style={{ color: 'var(--accent)' }}>Create an account</Link></>
          )}
        </div>
      </form>
    </div>
  );
}

const inputS = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  border: '1px solid var(--border-strong)',
  background: 'var(--surface)',
  outline: 'none',
  fontSize: 14,
  color: 'var(--fg)',
};

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 550, color: 'var(--fg-2)' }}>{label}</span>
      {children}
    </label>
  );
}
