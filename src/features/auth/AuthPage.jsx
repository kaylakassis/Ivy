// Shared Sign In / Sign Up screen. `mode` prop toggles between them.
import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useAuth } from '../../lib/auth.jsx';
import AuthShell from './AuthShell.jsx';

export default function AuthPage({ mode = 'signin' }) {
  const { signIn, signUp } = useAuth();
  const nav       = useNavigate();
  const location  = useLocation();
  // ?ref=CODE survives all the way to the signup POST so affiliate
  // attribution lands. Lowercased keys handled server-side; only
  // honored on the signup path.
  // ?email= prefills the address (client-invite links carry it) and
  // ?mode=client preselects the client role so an invited client claims
  // their portal instead of creating a business workspace.
  const params    = new URLSearchParams(location.search);
  const refCode   = params.get('ref');
  const [email,    setEmail]    = useState(params.get('email') || '');
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [name,     setName]     = useState('');
  const [role,     setRole]     = useState(params.get('mode') === 'client' ? 'client' : 'owner'); // 'owner' | 'client'
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [busy, setBusy]   = useState(false);
  const [err,  setErr]    = useState(null);
  // When signup succeeds but the welcome / verification email failed to
  // send, we hold the user on this screen with an explicit notice +
  // continue button rather than redirecting silently (the old
  // ?emailIssue param was never read anywhere).
  const [emailWarn, setEmailWarn] = useState(null);

  const isSignUp = mode === 'signup';
  const mismatch = isSignUp && confirm.length > 0 && confirm !== password;
  const canSubmit = !busy
    && (!isSignUp
      || (name.trim().length > 0 && password.length >= 8 && confirm === password && acceptedTerms));

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (isSignUp) {
      if (!name.trim()) { setErr('Please share your name'); return; }
      if (password.length < 8) { setErr('Password must be at least 8 characters'); return; }
      if (password !== confirm) { setErr("Passwords don't match"); return; }
      if (!acceptedTerms) {
        setErr('You must accept the Terms and Privacy Policy to continue.');
        return;
      }
    }
    setBusy(true);
    try {
      if (isSignUp) {
        // The signup endpoint returns { user, emailErrors? }. If
        // emailErrors is set, the welcome / verification email didn't
        // go out - hold the user here with an explicit notice + a
        // continue button so they know to resend from their account,
        // instead of redirecting silently.
        const r = await signUp(email, password, name.trim(), role, refCode);
        if (r?.emailErrors) {
          setEmailWarn(role === 'client' ? '/me' : '/');
          return;
        }
        nav(role === 'client' ? '/me' : '/', { replace: true });
      } else {
        await signIn(email, password);
        // For sign-in we let RoleRouter (in AppShell entry) figure out where
        // to land - pushing to '/' triggers it.
        nav('/', { replace: true });
      }
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
          <>
            <Field label="I'm signing up as a…">
              <RoleToggle value={role} onChange={setRole}/>
            </Field>
            <Field label="Your name">
              <input value={name} onChange={(e) => setName(e.target.value)}
                required minLength={1}
                autoComplete="name" style={inputS} />
            </Field>
          </>
        )}
        <Field label="Email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" style={inputS} />
        </Field>
        <Field label={isSignUp ? 'Password (8+ characters)' : 'Password'}>
          <PasswordInput value={password} onChange={setPassword}
            required minLength={isSignUp ? 8 : undefined}
            autoComplete={isSignUp ? 'new-password' : 'current-password'}/>
        </Field>
        {isSignUp && (
          <Field label="Confirm password">
            <PasswordInput value={confirm} onChange={setConfirm}
              required minLength={8}
              autoComplete="new-password"
              invalid={mismatch}/>
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
        )}
        {!isSignUp && (
          <div style={{ marginTop: -8, textAlign: 'right' }}>
            <Link to="/forgot-password" style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 500 }}>
              Forgot your password?
            </Link>
          </div>
        )}

        {/* Required-acceptance checkbox on signup. Server enforces the
            same requirement and refuses the POST without it; this is
            the soft guard. Wording explicitly calls out AI / financial /
            legal / business-outcome disclaimers so it can't be argued
            the user "didn't see" them. */}
        {isSignUp && (
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '12px 14px', borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
            fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55, cursor: 'pointer',
          }}>
            <input type="checkbox" checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
              style={{ marginTop: 3, flexShrink: 0 }}/>
            <span>
              I have read and agree to the{' '}
              <Link to="/terms"   target="_blank" rel="noopener" style={{ color: 'var(--accent)', fontWeight: 600 }}>Terms of Service</Link>{' '}and{' '}
              <Link to="/privacy" target="_blank" rel="noopener" style={{ color: 'var(--accent)', fontWeight: 600 }}>Privacy Policy</Link>,
              and I understand that Ivy OS - including the Ivy AI coach
              and every integrated third-party service - provides
              informational tools only, not financial, legal, tax, or
              other professional advice. I am responsible for my own
              business decisions and outcomes, and I will consult a
              qualified financial advisor and/or attorney for guidance
              on material decisions.
            </span>
          </label>
        )}

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        {emailWarn && (
          <div style={{
            padding: '12px 14px', borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
            fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55,
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <span>
              Your account is ready, but we couldn&apos;t send your confirmation
              email just now. You can resend it anytime from your account page
              (check your spam folder too).
            </span>
            <button type="button" className="btn btn-primary"
              onClick={() => nav(emailWarn, { replace: true })}
              style={{ justifyContent: 'center', padding: '10px 14px' }}>
              Continue <Icons.Arrow size={13} sw={2}/>
            </button>
          </div>
        )}

        {!emailWarn && (
        <button className="btn btn-primary" type="submit" disabled={!canSubmit}
          style={{ justifyContent: 'center', padding: '12px 14px', opacity: !canSubmit ? 0.6 : 1 }}>
          {busy ? 'Working…' : (isSignUp ? 'Create account' : 'Sign in')}
          {!busy && <Icons.Arrow size={14} sw={2} />}
        </button>
        )}

        <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>
          {isSignUp ? (
            <>Already have an account? <Link to="/signin" style={{ color: 'var(--accent)' }}>Sign in</Link></>
          ) : (
            <>New here? <Link to="/signup" style={{ color: 'var(--accent)' }}>Create an account</Link></>
          )}
        </div>

        {isSignUp && (
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.5 }}>
            By creating an account you agree to our{' '}
            <Link to="/terms" style={{ color: 'var(--fg-2)' }}>Terms</Link>{' '}and{' '}
            <Link to="/privacy" style={{ color: 'var(--fg-2)' }}>Privacy Policy</Link>.
          </div>
        )}
      </form>
    </AuthShell>
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

function RoleToggle({ value, onChange }) {
  const options = [
    { id: 'owner',  label: 'Business owner',  hint: 'I run a business and want to manage it.' },
    { id: 'client', label: 'Client / customer', hint: 'I book with a business that uses Ivy OS.' },
  ];
  return (
    <div className="form-2col" style={{ gap: 8 }}>
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button key={o.id} type="button" onClick={() => onChange(o.id)} style={{
            padding: '12px 12px', borderRadius: 10, textAlign: 'left',
            background: on ? 'var(--accent-soft)' : 'var(--surface)',
            border: '1.5px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
            cursor: 'pointer',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: on ? 'var(--accent)' : 'var(--fg)' }}>
              {o.label}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>
              {o.hint}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// Password input with a show/hide eye toggle.
// `invalid` adds a red border so it can be used for the "doesn't match" state.
export function PasswordInput({ value, onChange, invalid, ...rest }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
        style={{
          ...inputS,
          paddingRight: 40,
          borderColor: invalid ? 'var(--danger)' : 'var(--border-strong)',
        }}
      />
      <button type="button"
        onClick={() => setShow((s) => !s)}
        title={show ? 'Hide password' : 'Show password'}
        aria-label={show ? 'Hide password' : 'Show password'}
        tabIndex={-1}
        style={{
          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
          padding: 6, borderRadius: 6, color: 'var(--muted)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}>
        {show ? <Icons.EyeOff size={16}/> : <Icons.Eye size={16}/>}
      </button>
    </div>
  );
}
