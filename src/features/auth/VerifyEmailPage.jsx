// /verify-email?token=... - confirms email and bounces to dashboard.
// Works for both signed-in and signed-out users (the token is the proof).
//
// Idempotent: if the link was already consumed by an email-security
// prefetch (Outlook Safe Links, Apple Mail link preview, etc.) the
// server returns 200 with alreadyVerified: true and we render success.
// Only a TRULY invalid or expired link reaches the error state below.
import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api.js';
import AuthShell from './AuthShell.jsx';

export default function VerifyEmailPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { refresh, user } = useAuth();
  const token = params.get('token') || '';

  const [status, setStatus] = useState('verifying'); // 'verifying' | 'ok' | 'already' | 'error'
  const [errMsg, setErrMsg] = useState(null);
  // Guard against React StrictMode firing the effect twice on mount
  // (dev) or a tab visibility flicker re-triggering it. The token is
  // single-use; a second POST would consume the just-issued idempotent
  // success and confuse the state machine.
  const sentRef = useRef(false);

  useEffect(() => {
    if (!token) { setStatus('error'); setErrMsg('Missing verification token'); return; }
    if (sentRef.current) return;
    sentRef.current = true;
    let live = true;
    api.post('/auth/verify-email', { token })
      .then(async (r) => {
        if (!live) return;
        await refresh();
        setStatus(r?.alreadyVerified ? 'already' : 'ok');
        setTimeout(() => live && nav('/', { replace: true }), 1800);
      })
      .catch((e) => {
        if (!live) return;
        setStatus('error');
        setErrMsg(e.message || 'This link is invalid or has expired');
      });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <AuthShell>
      <div className="card" style={{
        width: '100%', maxWidth: 420, padding: 32,
        display: 'flex', flexDirection: 'column', gap: 18, textAlign: 'center',
      }}>
        <Brand center />
        {status === 'verifying' && (
          <>
            <h1 className="page-title" style={{ margin: 0, fontSize: 24 }}>Confirming your email…</h1>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>One moment.</p>
          </>
        )}
        {(status === 'ok' || status === 'already') && (
          <>
            <div style={{
              width: 56, height: 56, borderRadius: 99, alignSelf: 'center',
              background: 'var(--accent-soft)', color: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icons.Check size={28} sw={2.4} />
            </div>
            <h1 className="page-title" style={{ margin: 0, fontSize: 24 }}>
              {status === 'already' ? 'Already confirmed' : 'Email confirmed'}
            </h1>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>
              {status === 'already'
                ? "Looks like you've already confirmed this email. Taking you in…"
                : 'Taking you to your dashboard…'}
            </p>
          </>
        )}
        {status === 'error' && (
          <ErrorState errMsg={errMsg} user={user}/>
        )}
      </div>
    </AuthShell>
  );
}

// Error state for a truly-invalid/expired verification link. Surface
// a resend path for signed-in users so they don't have to navigate
// to /account to find it.
function ErrorState({ errMsg, user }) {
  const [resendState, setResendState] = useState(null); // null | 'sending' | 'sent' | { error }
  const handleResend = async () => {
    setResendState('sending');
    try {
      const r = await api.post('/auth/resend-verification');
      if (r?.alreadyVerified) setResendState({ alreadyVerified: true });
      else setResendState('sent');
    } catch (e) {
      setResendState({ error: e.message || 'Couldn\'t send the email - try again in a minute.' });
    }
  };
  return (
    <>
      <h1 className="page-title" style={{ margin: 0, fontSize: 24 }}>Couldn't confirm your email</h1>
      <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 13 }}>
        {errMsg || 'This link is invalid or has expired.'}
      </p>
      {user ? (
        // Signed-in user - let them resend without leaving the page.
        <>
          {resendState === 'sent' && (
            <div style={{
              padding: '10px 12px', borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              fontSize: 13,
            }}>
              Sent. Check your inbox (and spam folder) for the new link.
            </div>
          )}
          {resendState?.alreadyVerified && (
            <div style={{ fontSize: 13, color: 'var(--accent)' }}>
              Your email is already verified - no need to resend.
            </div>
          )}
          {resendState?.error && (
            <div style={{
              padding: '10px 12px', borderRadius: 8,
              background: 'rgba(155,44,44,0.10)', border: '1px solid rgba(155,44,44,0.30)',
              color: 'var(--danger)', fontSize: 12.5,
            }}>{resendState.error}</div>
          )}
          {!resendState?.alreadyVerified && (
            <button onClick={handleResend} className="btn btn-primary"
              disabled={resendState === 'sending' || resendState === 'sent'}
              style={{ justifyContent: 'center', padding: '12px 14px' }}>
              {resendState === 'sending' ? 'Sending…'
                : resendState === 'sent' ? 'Sent ✓'
                : 'Send me a fresh link'}
            </button>
          )}
          <Link to="/" style={{ fontSize: 12.5, color: 'var(--muted)' }}>Back to home</Link>
        </>
      ) : (
        // Signed-out - push them to sign in (the account page has a
        // resend button there too).
        <>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12 }}>
            Sign in and we'll show a "Resend verification" button.
          </p>
          <Link to="/signin" className="btn btn-primary" style={{ justifyContent: 'center', padding: '12px 14px' }}>
            Go to sign in
          </Link>
        </>
      )}
    </>
  );
}

function Brand({ center }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: center ? 'center' : 'flex-start' }}>
      <div style={{
        width: 34, height: 34, borderRadius: 8,
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Logo size={22} color="currentColor" />
      </div>
      <div style={{ textAlign: 'left' }}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em' }}>Ivy OS</div>
        <div className="metric-label" style={{ fontSize: 10, marginTop: 2 }}>Business OS</div>
      </div>
    </div>
  );
}
