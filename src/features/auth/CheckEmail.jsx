// "Check your email": the step after the sign-up form.
//
// Sign-up answers the same way whatever address was typed (the server does
// not say whether it already has an account; the email does). This screen
// waits for the link in that email to be opened, then carries the person
// straight in: it asks every few seconds whether the link has been opened
// (api/auth/signup-status.js, using the ticket the sign-up answer carried),
// and when it has, uses the session the link created in this browser or,
// failing that, signs in with the password they just chose (still in
// memory, never stored).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { useIntervalWhenVisible } from '../../lib/useIntervalWhenVisible.js';

const WAIT_LIMIT_MS = 30 * 60 * 1000;

export default function CheckEmail({ email, password, ticket, onResend, onBack, onDone }) {
  const { signIn, refresh } = useAuth();
  const [note, setNote] = useState(null);       // plain status line under the buttons
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [stuck, setStuck] = useState(false);    // confirmed, but could not be signed in from here
  const startedAt = useRef(Date.now());
  const finishing = useRef(false);

  const finish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    try {
      // The link may have been opened in this same browser, which signs it
      // in. Otherwise sign in with what was typed a moment ago.
      const here = await api.get('/auth/me').then(() => true, () => false);
      if (here) await refresh(); else await signIn(email, password);
      onDone();
    } catch {
      setStuck(true);
    }
  }, [email, password, refresh, signIn, onDone]);

  const check = useCallback(async (asked = false) => {
    if (finishing.current || !ticket) return;
    if (!asked && Date.now() - startedAt.current > WAIT_LIMIT_MS) return;
    try {
      const r = await api.post('/auth/signup-status', { ticket });
      if (r?.confirmed) { await finish(); return; }
      if (asked) setNote('We do not see it yet. Open the email from Ivy and tap the button in it, then come back here.');
    } catch {
      if (asked) setNote('Could not check just now. Try again in a moment.');
    }
  }, [ticket, finish]);

  useIntervalWhenVisible(() => { check(false); }, 4000);
  useEffect(() => { startedAt.current = Date.now(); finishing.current = false; setStuck(false); setNote(null); }, [ticket]);

  const again = async () => {
    setBusy(true); setNote(null);
    try { await onResend(); setResent(true); setNote('Sent again. It can take a minute to arrive.'); }
    catch (e) { setNote(e?.message || 'Could not send it again just now. Try again in a minute.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card auth-card" data-check-email style={{ width: '100%', maxWidth: 420, padding: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        width: 52, height: 52, borderRadius: 99, background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Mail size={24} sw={1.9}/></div>
      <h1 className="page-title" style={{ margin: 0, fontSize: 24 }}>Check your email</h1>
      <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        We sent an email to <strong style={{ overflowWrap: 'anywhere' }}>{email}</strong>. Open it and tap the button to finish. This page will carry on by itself.
      </p>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        Nothing after a minute? Look in your spam folder. If this address already has an Ivy account, the email tells you how to sign in instead.
      </p>

      {stuck ? (
        <div role="status" style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Your email is confirmed. <Link to={`/signin?email=${encodeURIComponent(email)}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>Sign in</Link> to continue.
        </div>
      ) : (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => check(true)}
          style={{ justifyContent: 'center', padding: '12px 14px', minHeight: 44 }}>
          I have opened the link <Icons.Arrow size={14} sw={2}/>
        </button>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-outline" disabled={busy || resent} onClick={again} style={{ flex: '1 1 150px', justifyContent: 'center', minHeight: 44 }}>
          {busy ? 'Sending…' : resent ? 'Sent again' : 'Send it again'}
        </button>
        <button type="button" className="btn btn-outline" disabled={busy} onClick={onBack} style={{ flex: '1 1 150px', justifyContent: 'center', minHeight: 44 }}>
          Use a different email
        </button>
      </div>
      {note && <div role="status" style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}
