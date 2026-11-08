// /shops/invite/:token - landing for "{Shop} invited you to be listed on
// their shop page". Shows exactly what the page will show about the pro
// and what it never shows, then Accept / Decline. Signed-out visitors are
// sent to sign in (or create a business) and come straight back.
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AuthShell from '../auth/AuthShell.jsx';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';

const h1 = { fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em', margin: '0 0 8px' };
const p = { fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, margin: 0 };

export function WhatIsShared({ shared, neverShared }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 14 }}>
      <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ok)', marginBottom: 6 }}>Shown on the page</div>
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, lineHeight: 1.6, color: 'var(--fg-2)' }}>
          {(shared || []).map((s) => <li key={s}>{s}</li>)}
        </ul>
      </div>
      <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--danger)', marginBottom: 6 }}>Never shown</div>
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, lineHeight: 1.6, color: 'var(--fg-2)' }}>
          {(neverShared || []).map((s) => <li key={s}>{s}</li>)}
        </ul>
      </div>
    </div>
  );
}

export default function AcceptShopInvite() {
  const { token } = useParams();
  const nav = useNavigate();
  const { user, loading: authLoading, refresh } = useAuth();
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  const [dead, setDead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (done) return undefined;
    let live = true;
    api.get(`/shops/invite?token=${encodeURIComponent(token)}`)
      .then((r) => live && setInfo(r))
      .catch((e) => {
        if (!live) return;
        if (e.status === 410) setDead(true);
        else setErr(e.message || 'This invite link is not valid.');
      });
    return () => { live = false; };
  }, [token, user?.id, done]);

  const here = `/shops/invite/${encodeURIComponent(token)}`;
  const answer = async (action) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/shops/invite', { token, action });
      await refresh?.();
      setDone({ action, ...r });
    } catch (e) {
      if (e.status === 410) setDead(true);
      else setErr(e.message || 'Something went wrong');
    } finally { setBusy(false); }
  };

  return (
    <AuthShell>
      <div className="card" style={{ width: '100%', maxWidth: 480, padding: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icons.Store size={18}/>
          </div>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)' }}>Shop page invite</div>
        </div>

        {dead && (
          <>
            <h1 style={h1}>This invite link is not valid any more</h1>
            <p style={p}>It was used, declined, or it expired. Ask the shop to send a new one.</p>
            <div style={{ marginTop: 16 }}><Link to="/" className="btn btn-outline" style={{ textDecoration: 'none' }}>Go to Ivy</Link></div>
          </>
        )}
        {!dead && err && !info && (
          <>
            <h1 style={h1}>This link is not valid</h1>
            <p style={p}>{err}</p>
            <div style={{ marginTop: 16 }}><Link to="/" className="btn btn-outline" style={{ textDecoration: 'none' }}>Go to Ivy</Link></div>
          </>
        )}
        {!dead && !err && !info && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Checking your invite…</div>}

        {info && done && (
          <>
            <h1 style={h1}>{done.action === 'accept' ? `You are listed on ${info.shop.name}` : 'Invite declined'}</h1>
            <p style={p}>
              {done.action === 'accept'
                ? (done.shop?.status === 'published'
                  ? 'Your listing is live on their shop page. Edit your title, bio and which services show under Shop in your app, and leave any time with one tap.'
                  : 'You show on their shop page as soon as they publish it. Edit your title, bio and which services show under Shop in your app, and leave any time with one tap.')
                : `${info.shop.name} has been told. Nothing of yours goes on their page.`}
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => nav('/shops', { replace: true })}>Open Shop <Icons.Arrow size={14}/></button>
              {done.action === 'accept' && done.shop?.status === 'published' && (
                <a className="btn btn-outline" style={{ textDecoration: 'none' }} href={`/shop/${encodeURIComponent(info.shop.slug)}`}>See the page</a>
              )}
            </div>
          </>
        )}

        {info && !done && (
          <>
            <h1 style={h1}>{info.shop.name} invited you to be listed on their shop page</h1>
            <p style={p}>
              <strong style={{ color: 'var(--fg)' }}>{info.ownerBusinessName}</strong> runs the page{info.shop.addressLabel ? ` for ${info.shop.addressLabel}` : ''}.
              {info.memberCount > 0 && <> {info.memberCount} {info.memberCount === 1 ? 'business is' : 'businesses are'} already on it{info.memberNames?.length ? ` (${info.memberNames.join(', ')})` : ''}.</>}
              {' '}Clients who book you from it book with you directly, at your prices and under your policies. Your clients stay yours, and you can leave with one tap.
            </p>
            <WhatIsShared shared={info.shared} neverShared={info.neverShared}/>
            {info.email && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 12 }}>Invite for <strong style={{ color: 'var(--fg)' }}>{info.email}</strong></div>}
            <p style={{ ...p, marginTop: 12, fontSize: 12.5 }}>{info.planNote}</p>

            {err && <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: 'color-mix(in srgb, var(--danger) 10%, var(--surface))', color: 'var(--danger)', fontSize: 13 }}>{err}</div>}

            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {authLoading ? null : !user ? (
                <>
                  <Link className="btn btn-primary" style={{ justifyContent: 'center', textDecoration: 'none' }} to={`/signin?next=${encodeURIComponent(here)}${info.email ? `&email=${encodeURIComponent(info.email)}` : ''}`}>Sign in to accept</Link>
                  <Link className="btn btn-outline" style={{ justifyContent: 'center', textDecoration: 'none' }} to={`/signup?next=${encodeURIComponent(here)}`}>New to Ivy? Create your business</Link>
                </>
              ) : info.me?.isShopOwner ? (
                <p style={p}>This is your own shop page. You are already on it.</p>
              ) : !info.me?.hasBusiness ? (
                <>
                  <p style={p}>You are signed in as {user.email}, but this account has no Ivy business yet. A shop page lists businesses, so create yours first and open this link again.</p>
                  <Link className="btn btn-primary" style={{ justifyContent: 'center', textDecoration: 'none' }} to="/onboarding">Set up my business</Link>
                </>
              ) : !info.me?.planActive ? (
                <>
                  <p style={p}>Your business needs an active plan, trial or complimentary access to be listed. Start or renew your plan, then open this link again.</p>
                  <Link className="btn btn-primary" style={{ justifyContent: 'center', textDecoration: 'none' }} to="/account#billing">Open billing</Link>
                </>
              ) : (
                <>
                  <button className="btn btn-primary" style={{ justifyContent: 'center', textDecoration: 'none' }} disabled={busy} onClick={() => answer('accept')}>
                    {busy ? 'Working…' : `Accept as ${info.me?.businessName || user.email}`}
                  </button>
                  <button className="btn btn-outline" style={{ justifyContent: 'center', textDecoration: 'none' }} disabled={busy} onClick={() => answer('decline')}>Decline</button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </AuthShell>
  );
}
