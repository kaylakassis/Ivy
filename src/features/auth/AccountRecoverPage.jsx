// /account-recover?token=... - undo a soft-deleted account using the
// recovery token from the deletion confirmation email. Auto-submits the
// token on load (one-click recovery), with a clear retry / error state if
// the link is expired, used, or otherwise invalid.
import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import AuthShell from './AuthShell.jsx';

export default function AccountRecoverPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') || '';

  const [state, setState] = useState(token ? 'working' : 'no-token');
  const [err, setErr]     = useState(null);
  const [restored, setRestored] = useState(null);
  const tried = useRef(false);

  // Auto-fire once on mount when a token is present. Guarded by a ref so
  // StrictMode's double-invoke (dev only) doesn't double-submit.
  useEffect(() => {
    if (!token || tried.current) return;
    tried.current = true;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.post('/account/restore', { token });
        if (cancelled) return;
        setRestored(r.user || null);
        setState('done');
      } catch (ex) {
        if (cancelled) return;
        setErr(ex.message || 'Could not restore your account.');
        setState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <AuthShell>
      <div className="card" style={{
        padding: 28, width: '100%', maxWidth: 440,
        display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start',
      }}>
        {state === 'no-token' && (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Recovery link required</h1>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              Open the account-deletion email we sent you and click the <strong>Keep my account</strong> button to restore your Ivy account.
            </p>
            <Link to="/" className="btn btn-outline" style={{ marginTop: 8 }}>
              Back to home
            </Link>
          </>
        )}

        {state === 'working' && (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>
              Restoring your account…
            </h1>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              Hang tight — this only takes a second.
            </p>
          </>
        )}

        {state === 'done' && (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icons.Check size={20} sw={2}/> Welcome back
            </h1>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              Your Ivy account{restored?.email ? ` (${restored.email})` : ''} is restored. Your clients, bookings, invoices, and history are exactly where you left them.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => nav('/', { replace: true })}>
              Go to my dashboard
            </button>
          </>
        )}

        {state === 'error' && (
          <>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>We couldn't restore this account</h1>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              {err || 'This recovery link is invalid, already used, or expired.'}
            </p>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
              Recovery links work for 30 days after deletion. If yours has expired, the account is no longer recoverable. If you think this is wrong, reach us at <a href="mailto:hello@joinivy.ai" style={{ color: 'var(--accent)' }}>hello@joinivy.ai</a>.
            </p>
            <Link to="/" className="btn btn-outline">Back to home</Link>
          </>
        )}
      </div>
    </AuthShell>
  );
}
