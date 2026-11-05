// "We updated our Privacy Policy" notice. Shown to a signed-in person whose
// accepted Privacy Policy version is older than the current one
// (api/auth/me.js privacy.needsAcknowledgement). It does not list the
// changes: it says the policy was updated, lets them read the whole policy
// right here (loaded only when they open it), and records their acceptance
// on "Accept" (opt in). "Decline" (opt out) explains that accepting is
// required to use Ivy and offers two ways forward: review it again and
// accept, or go to the account page to cancel the subscription, download
// their data and close the account. While they are on that account page the
// notice steps aside (a slim banner stays); anywhere else it returns.
// Never shown on top of the Terms prompt.
import React, { Suspense, lazy, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from './Icons.jsx';
import { useAuth } from '../lib/auth.jsx';

const PolicyBody = lazy(() => import('../features/legal/PrivacyPage.jsx').then((m) => ({ default: m.PrivacyPolicyBody })));

export default function PrivacyUpdateNotice() {
  const { user, privacyUpdatePending, acknowledgePrivacy } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const nav = useNavigate();
  const [declined, setDeclined] = useState(() => {
    try { return sessionStorage.getItem('ivy_privacy_declined') === '1'; } catch { return false; }
  });
  const markDeclined = (v) => {
    setDeclined(v);
    try { if (v) sessionStorage.setItem('ivy_privacy_declined', '1'); else sessionStorage.removeItem('ivy_privacy_declined'); } catch { /* private mode */ }
  };
  // Where this person manages their account (clients and helpers have their own).
  const role = pathname.startsWith('/me') ? 'client' : pathname.startsWith('/helper') ? 'helper' : 'owner';
  const accountPath = role === 'client' ? '/me/profile' : role === 'helper' ? '/helper/account' : '/account';
  if (!user || !privacyUpdatePending) return null;

  const ok = async () => {
    setBusy(true); setErr(null);
    try { await acknowledgePrivacy(); markDeclined(false); }
    catch (e) { setErr(e.message || 'Could not save that. Please try again.'); setBusy(false); }
  };

  const leaveOptions = role === 'owner'
    ? 'cancel your subscription, download your data and close your account'
    : 'download your data and close your account';

  // Declined and now on their account page: let them use it, with a banner.
  if (declined && pathname.startsWith(accountPath)) {
    return (
      <div role="status" style={{
        position: 'fixed', left: 12, right: 12, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)', zIndex: 290,
        maxWidth: 560, margin: '0 auto', padding: '12px 14px', borderRadius: 12,
        background: 'var(--surface)', border: '1px solid var(--border-strong)', boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 13, color: 'var(--fg-2)',
      }}>
        <span style={{ flex: '1 1 220px' }}>You declined the updated Privacy Policy. Accepting it is required to keep using Ivy.</span>
        <button type="button" className="btn btn-primary" style={{ padding: '8px 14px', fontSize: 12.5 }}
          onClick={() => { markDeclined(false); setOpen(true); }}>
          Review and accept
        </button>
      </div>
    );
  }

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
{declined ? (
        <>
        <h2 id="privacy-update-title" style={{
          margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500,
          fontSize: 21, letterSpacing: '-0.02em', lineHeight: 1.25,
        }}>Accepting the Privacy Policy is required to use Ivy</h2>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          The Privacy Policy explains how Ivy keeps and uses the information that runs your account, so we need your agreement before you continue.
          You can read it again and accept whenever you're ready. If you'd rather not, you can {leaveOptions} from your account settings.
        </p>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
          Questions? Email <a href="mailto:privacy@joinivy.ai" style={{ color: 'var(--accent)' }}>privacy@joinivy.ai</a>.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-outline" style={{ padding: '10px 16px' }}
            onClick={() => nav(accountPath)}>
            Go to account settings
          </button>
          <button type="button" className="btn btn-primary" style={{ padding: '10px 18px' }}
            onClick={() => { markDeclined(false); setOpen(true); }}>
            Review and accept
          </button>
        </div>
        </>
        ) : (
        <>
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
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" onClick={() => markDeclined(true)} disabled={busy} className="btn btn-outline" style={{ padding: '10px 18px' }}>
            Decline
          </button>
          <button type="button" onClick={ok} disabled={busy} className="btn btn-primary" style={{ padding: '10px 22px' }}>
            {busy ? 'Saving…' : 'Accept'}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
