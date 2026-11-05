// "We updated our Privacy Policy" notice. Shown to a signed-in person whose
// accepted Privacy Policy version is older than the current one
// (api/auth/me.js privacy.needsAcknowledgement). It does not list the
// changes: it says the policy was updated, lets them read the whole policy
// right here (loaded only when they open it), and records their acceptance
// on "Accept". They can't use the app behind it until they accept; anyone
// who doesn't agree is pointed to exporting their data and closing their
// account. Never shown on top of the Terms prompt.
import React, { Suspense, lazy, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icons } from './Icons.jsx';
import { useAuth } from '../lib/auth.jsx';

const PolicyBody = lazy(() => import('../features/legal/PrivacyPage.jsx').then((m) => ({ default: m.PrivacyPolicyBody })));

export default function PrivacyUpdateNotice() {
  const { user, privacyUpdatePending, acknowledgePrivacy } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  // Where this person manages their account (clients and helpers have their own).
  const accountPath = pathname.startsWith('/me') ? '/me/profile' : pathname.startsWith('/helper') ? '/helper/account' : '/account';
  if (!user || !privacyUpdatePending) return null;

  const ok = async () => {
    setBusy(true); setErr(null);
    try { await acknowledgePrivacy(); }
    catch (e) { setErr(e.message || 'Could not save that. Please try again.'); setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="privacy-update-title"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 290,
        background: 'rgba(10, 12, 8, 0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, overflowY: 'auto',
      }}>
      <div className="card" style={{
        width: '100%', maxWidth: 500, padding: 26,
        display: 'flex', flexDirection: 'column', gap: 14,
        border: '1px solid var(--border-strong)', background: 'var(--surface)',
        boxShadow: '0 30px 80px rgba(0,0,0,0.35)',
      }}>
        <div style={{
          width: 42, height: 42, borderRadius: 12, alignSelf: 'flex-start',
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Lock size={19}/></div>
        <h2 id="privacy-update-title" style={{
          margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500,
          fontSize: 21, letterSpacing: '-0.02em', lineHeight: 1.25,
        }}>We updated our Privacy Policy</h2>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Please review it and tap Accept to keep using Ivy.
        </p>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="btn btn-outline" style={{ alignSelf: 'flex-start', padding: '8px 14px', fontSize: 12.5 }}>
          {open ? 'Hide the policy' : 'Read the Privacy Policy'}
          <Icons.ArrowDown size={11} sw={2} style={{ transform: open ? 'rotate(180deg)' : 'none' }}/>
        </button>
        {open && (
          <div className="scroll" tabIndex={0} aria-label="Privacy Policy"
            style={{
              maxHeight: '45vh', overflowY: 'auto', overscrollBehavior: 'contain',
              padding: '4px 14px 10px', borderRadius: 10,
              border: '1px solid var(--border)', background: 'var(--surface-2)',
              fontSize: 13, lineHeight: 1.6, color: 'var(--fg-2)',
            }}>
            <Suspense fallback={<div style={{ padding: 12, color: 'var(--muted)' }}>Loading the policy…</div>}>
              <PolicyBody/>
            </Suspense>
          </div>
        )}
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          Don't agree? You can <Link to={accountPath} style={{ color: 'var(--accent)' }}>download your data and close your account</Link>, or email <a href="mailto:privacy@joinivy.ai" style={{ color: 'var(--accent)' }}>privacy@joinivy.ai</a>.
        </p>
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" onClick={ok} disabled={busy} className="btn btn-primary" style={{ padding: '10px 22px' }}>
            {busy ? 'Saving…' : 'Accept'}
          </button>
        </div>
      </div>
    </div>
  );
}
