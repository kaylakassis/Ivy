// "We updated our Privacy Policy" notice. Shown once to a signed-in person
// whose acknowledged Privacy Policy version is older than the current one
// (api/auth/me.js privacy.needsAcknowledgement). Unlike the Terms prompt
// this does not block the app: it explains what changed in plain words,
// links to the full policy, and records the acknowledgement on "Got it".
// Never shown on top of the Terms prompt.
import React, { useState } from 'react';
import LegalLink from './LegalLink.jsx';
import { Icons } from './Icons.jsx';
import { useAuth } from '../lib/auth.jsx';

export default function PrivacyUpdateNotice() {
  const { user, privacyUpdatePending, acknowledgePrivacy } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
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
          Two things are now spelled out more clearly. Nothing about who your data is shared with has changed, and we still never sell it.
        </p>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          <li><b style={{ color: 'var(--fg)' }}>Business totals stay private.</b> A small number of authorized Ivy team members can see totals for your account, like revenue collected through Ivy, to support you and keep Ivy running well. They are never published in a way that identifies you or your clients.</li>
          <li><b style={{ color: 'var(--fg)' }}>Anonymous combined stats.</b> We may share figures about Ivy as a whole, like the total collected by businesses on Ivy. These combine many businesses and never name or identify anyone.</li>
        </ul>
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <LegalLink to="/privacy" className="btn btn-outline" style={{ padding: '8px 14px', fontSize: 12.5 }}>
            Read the full policy <Icons.Arrow size={11} sw={2}/>
          </LegalLink>
          <div style={{ flex: 1 }}/>
          <button type="button" onClick={ok} disabled={busy} className="btn btn-primary" style={{ padding: '10px 18px' }}>
            {busy ? 'Saving…' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  );
}
