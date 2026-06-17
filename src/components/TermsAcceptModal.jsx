// Forced re-acceptance modal. Renders for any signed-in user whose
// stored terms_version differs from the current server-side version
// (including users who predate the column entirely). Blocks the app
// with a backdrop they can't click through; the only way out is to
// accept or sign out.
//
// The legal copy here is a short summary — the full Terms + Privacy
// open in a new tab via the prominent links. The same explicit
// language as the signup checkbox is reused so this isn't a softer
// re-prompt than the original consent.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from './Icons.jsx';
import { useAuth } from '../lib/auth.jsx';

export default function TermsAcceptModal() {
  const { user, mustAcceptTerms, acceptCurrentTerms, signOut, terms } = useAuth();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Hide the modal entirely if the user has accepted, isn't signed in,
  // or is on a public-only path. AuthProvider doesn't know the route,
  // so we mount this from AppShell + ClientShell — the modal itself
  // bails when there's nothing to ask.
  if (!user || !mustAcceptTerms) return null;

  const accept = async () => {
    if (!checked) return;
    setBusy(true); setErr(null);
    try { await acceptCurrentTerms(); }
    catch (e) { setErr(e.message || 'Could not record acceptance.'); setBusy(false); }
  };

  const out = async () => { await signOut(); window.location.href = '/signin'; };

  // First-acceptance vs re-acceptance — the framing changes slightly.
  const isFirstTime = !terms?.acceptedVersion;
  const heading = isFirstTime
    ? 'Before you continue: confirm a few things.'
    : 'We updated our Terms.';
  const intro = isFirstTime
    ? "Your account was created before we tracked acceptance explicitly. Take a minute to confirm the disclaimers below — we want every user to have seen them."
    : `Our Terms of Service were updated to version ${terms?.currentVersion || 'the current version'}. Take a minute to read what changed and confirm before continuing.`;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="terms-accept-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'rgba(10, 12, 8, 0.7)',
        backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, overflowY: 'auto',
      }}>
      <div className="card" style={{
        width: '100%', maxWidth: 540, padding: 28,
        display: 'flex', flexDirection: 'column', gap: 16,
        boxShadow: '0 30px 80px rgba(0,0,0,0.4)',
        border: '1px solid var(--border-strong)',
        background: 'var(--surface)',
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, alignSelf: 'flex-start',
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Doc size={20}/></div>

        <div>
          <h2 id="terms-accept-title" style={{
            margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500,
            fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1.2,
          }}>{heading}</h2>
          <p style={{ margin: '10px 0 0', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            {intro}
          </p>
        </div>

        {/* Two prominent links so the user can read the full text in
            another tab before checking the box. */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Link to="/terms" target="_blank" rel="noopener" className="btn btn-outline"
            style={{ padding: '7px 14px', fontSize: 12.5 }}>
            Read Terms <Icons.Arrow size={11} sw={2}/>
          </Link>
          <Link to="/privacy" target="_blank" rel="noopener" className="btn btn-outline"
            style={{ padding: '7px 14px', fontSize: 12.5 }}>
            Read Privacy Policy <Icons.Arrow size={11} sw={2}/>
          </Link>
        </div>

        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '12px 14px', borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
          fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55, cursor: 'pointer',
        }}>
          <input type="checkbox" checked={checked} disabled={busy}
            onChange={(e) => setChecked(e.target.checked)}
            style={{ marginTop: 3, flexShrink: 0 }}/>
          <span>
            I have read and agree to the{' '}
            <Link to="/terms" target="_blank" rel="noopener" style={{ color: 'var(--accent)', fontWeight: 600 }}>Terms of Service</Link>{' '}and{' '}
            <Link to="/privacy" target="_blank" rel="noopener" style={{ color: 'var(--accent)', fontWeight: 600 }}>Privacy Policy</Link>,
            and I understand that Ivy OS — including the Ivy AI coach
            and every integrated third-party service — provides
            informational tools only, not financial, legal, tax, or
            other professional advice. I am responsible for my own
            business decisions and outcomes, and I will consult a
            qualified financial advisor and/or attorney for guidance
            on material decisions.
          </span>
        </label>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)',
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={out} className="btn btn-ghost" style={{ color: 'var(--muted)' }}>
            Sign out
          </button>
          <div style={{ flex: 1 }}/>
          <button onClick={accept} disabled={!checked || busy}
            className="btn btn-primary"
            style={{ padding: '10px 18px', opacity: (!checked || busy) ? 0.6 : 1 }}>
            {busy ? 'Saving…' : 'Accept and continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
