// /verify-email?token=... — confirms email and bounces to dashboard.
// Works for both signed-in and signed-out users (the token is the proof).
import React, { useEffect, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useTweaks } from '../../lib/tweaks.js';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api.js';

export default function VerifyEmailPage() {
  const [tweaks] = useTweaks();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const token = params.get('token') || '';

  const [status, setStatus] = useState('verifying'); // 'verifying' | 'ok' | 'error'
  const [errMsg, setErrMsg] = useState(null);

  useEffect(() => {
    if (!token) { setStatus('error'); setErrMsg('Missing verification token'); return; }
    let live = true;
    api.post('/auth/verify-email', { token })
      .then(async () => {
        if (!live) return;
        await refresh();
        setStatus('ok');
        setTimeout(() => live && nav('/', { replace: true }), 1500);
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
    <div className={`app-root dir-${tweaks.direction}`} style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
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
        {status === 'ok' && (
          <>
            <div style={{
              width: 56, height: 56, borderRadius: 99, alignSelf: 'center',
              background: 'var(--accent-soft)', color: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icons.Check size={28} sw={2.4} />
            </div>
            <h1 className="page-title" style={{ margin: 0, fontSize: 24 }}>Email confirmed</h1>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>Taking you to your dashboard…</p>
          </>
        )}
        {status === 'error' && (
          <>
            <h1 className="page-title" style={{ margin: 0, fontSize: 24 }}>Couldn't confirm your email</h1>
            <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 13 }}>
              {errMsg || 'This link is invalid or has expired.'}
            </p>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12 }}>
              Sign in and we'll show a "Resend verification" button.
            </p>
            <Link to="/signin" className="btn btn-primary" style={{ justifyContent: 'center', padding: '12px 14px' }}>
              Go to sign in
            </Link>
          </>
        )}
      </div>
    </div>
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
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em' }}>thryve</div>
        <div className="metric-label" style={{ fontSize: 10, marginTop: 2 }}>Business OS</div>
      </div>
    </div>
  );
}
