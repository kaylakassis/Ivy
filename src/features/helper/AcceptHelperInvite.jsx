// /helper/invite/:token - landing for the "<Business> invited you to help
// out on Ivy" email.
//
//   • Email already has an Ivy account → sign in (we bounce through
//     /signin with next= back here), then one tap to accept.
//   • New to Ivy → name + password + terms creates the sign-in and
//     accepts in the same request. No business workspace is created.
//
// Expired / used / cancelled links all read the same so the page is not
// an oracle for guessing tokens.
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AuthShell from '../auth/AuthShell.jsx';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { clearMeCache, forgetLanding } from '../../lib/landing.js';
import { isNative } from '../../lib/platform.js';
import { setNativeAuthToken } from '../../lib/nativeAuth.js';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../../lib/legal.js';
import HelperGone from './HelperGone.jsx';

const card = {
  width: '100%', maxWidth: 420, padding: 26,
};

export default function AcceptHelperInvite() {
  const { token } = useParams();
  const nav = useNavigate();
  const { user, loading: authLoading, refresh, signOut } = useAuth();
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  // A link we issued that no longer works (cancelled, used, expired):
  // the API answers 410 with its status. Shown as the same friendly
  // screen the helper shell uses when access was removed.
  const [dead, setDead] = useState(null);
  const [meCtx, setMeCtx] = useState(null);

  useEffect(() => {
    // Once accepted the token is burned on purpose; re-checking it (the
    // sign-in refresh changes user.id) would wrongly show the dead-link state.
    if (done) return undefined;
    let live = true;
    api.get(`/helper/invite?token=${encodeURIComponent(token)}`)
      .then((r) => live && setInfo(r))
      .catch((e) => {
        if (!live) return;
        if (e.status === 410 && e.details?.status) setDead(e.details.status);
        else setErr(e.message || 'This invite link is not valid.');
      });
    return () => { live = false; };
  }, [token, user?.id, done]);

  // Signed in while landing on a dead link: the screen offers "go to your
  // business / portal" instead of a trial when that applies.
  useEffect(() => {
    if (!user || !dead) return;
    let live = true;
    api.get('/me').then((r) => live && setMeCtx(r)).catch(() => {});
    return () => { live = false; };
  }, [user, dead]);

  if (dead) {
    return (
      <AuthShell>
        <HelperGone kind={dead === 'expired' ? 'expired' : 'revoked'} ctx={user ? meCtx : null}/>
      </AuthShell>
    );
  }

  const here = `/helper/invite/${encodeURIComponent(token)}`;

  const accept = async (e) => {
    e?.preventDefault?.();
    setErr(null);
    if (!info.hasAccount) {
      if (!name.trim()) { setErr('Your name is required'); return; }
      if (password.length < 8) { setErr('Password must be at least 8 characters'); return; }
      if (!agree) { setErr('You must accept the Terms and Privacy Policy to continue.'); return; }
    }
    setBusy(true);
    try {
      const r = await api.post('/helper/accept', info.hasAccount ? { token } : {
        token, name: name.trim(), password,
        acceptedTermsVersion: CURRENT_TERMS_VERSION, acceptedPrivacyVersion: CURRENT_PRIVACY_VERSION,
      });
      if (isNative() && r?.token) await setNativeAuthToken(r.token);
      clearMeCache(); forgetLanding();
      try { localStorage.setItem('ivy_helper_ws', r.workspaceId); } catch { /* private mode */ }
      await refresh?.();
      setDone(r);
    } catch (ex) {
      if (ex.status === 401 && ex.details?.error === 'sign-in-required') {
        nav(`/signin?email=${encodeURIComponent(info.email)}&next=${encodeURIComponent(here)}`, { replace: true });
        return;
      }
      setErr(ex.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const signedInAsSomeoneElse = !!user && info && user.email?.toLowerCase() !== info.email;

  return (
    <AuthShell>
      <div className="card" style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: '#042b25', overflow: 'hidden' }}>
            <img src="/icon-512.png" alt="" style={{ width: '100%', height: '100%', display: 'block' }}/>
          </div>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)' }}>Helper invite</div>
        </div>

        {err && !info && (
          <>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em', margin: '0 0 8px' }}>This link is not valid</h1>
            <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, margin: 0 }}>{err}</p>
            <div style={{ marginTop: 16 }}><Link to="/" className="btn btn-outline">Go to Ivy</Link></div>
          </>
        )}

        {!err && !info && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Checking your invite…</div>}

        {info && done && (
          <>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em', margin: '0 0 8px' }}>You are in</h1>
            <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, margin: 0 }}>
              You now help out at <strong>{done.businessName}</strong>. Your schedule shows the sessions they assign to you.
            </p>
            <button className="btn btn-primary" style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
              onClick={() => nav(`/helper?ws=${encodeURIComponent(done.workspaceId)}`, { replace: true })}>
              Open my schedule <Icons.Arrow size={14}/>
            </button>
          </>
        )}

        {info && !done && (
          <form onSubmit={accept}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em', margin: '0 0 8px' }}>
              {info.businessName} invited you to help out
            </h1>
            <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, margin: 0 }}>
              With your own sign-in you see the sessions assigned to you, the client details for those sessions, and you can mark them done. Nothing else.
            </p>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 10 }}>Invite for <strong style={{ color: 'var(--fg)' }}>{info.email}</strong></div>

            {signedInAsSomeoneElse && (
              <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: 'var(--surface-2)', fontSize: 13, lineHeight: 1.5 }}>
                You are signed in as <strong>{user.email}</strong>. Sign out first, then open this link again.
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-outline" onClick={async () => { await signOut(); }}>Sign out</button>
                </div>
              </div>
            )}

            {!signedInAsSomeoneElse && info.hasAccount && (
              <div style={{ marginTop: 16 }}>
                {authLoading ? null : user ? (
                  <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
                    {busy ? 'Joining…' : `Accept as ${user.email}`}
                  </button>
                ) : (
                  <>
                    <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>This email already has an Ivy account. Sign in to accept.</p>
                    <Link className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
                      to={`/signin?email=${encodeURIComponent(info.email)}&next=${encodeURIComponent(here)}`}>
                      Sign in to accept
                    </Link>
                  </>
                )}
              </div>
            )}

            {!signedInAsSomeoneElse && !info.hasAccount && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <label style={lbl}>Your name
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required style={inp}/>
                </label>
                <label style={lbl}>Choose a password
                  <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password" minLength={8} required style={inp}/>
                </label>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 3 }}/>
                  <span>I agree to the <Link to="/terms" style={{ color: 'var(--accent)' }}>Terms</Link> and <Link to="/privacy" style={{ color: 'var(--accent)' }}>Privacy Policy</Link>.</span>
                </label>
                <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
                  {busy ? 'Creating your sign-in…' : 'Create my sign-in and join'}
                </button>
              </div>
            )}

            {err && <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
          </form>
        )}
      </div>
    </AuthShell>
  );
}

const lbl = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase' };
const inp = { width: '100%', fontSize: 14, textTransform: 'none', letterSpacing: 0, fontWeight: 400 };
