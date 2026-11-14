// Shown instead of the app (and instead of the paywall) when the business
// is on a risk hold (api/_lib/riskHold.js). Subscribing would not unlock
// it, so there is no subscribe button: just what happened, how to reach
// us, and a way to sign out. Nothing is deleted while a hold is in place.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';
import { useAuth } from '../../lib/auth.jsx';

export default function AccountOnHold({ ctx }) {
  const { signOut } = useAuth();
  const biz = ctx?.owns?.bizName || 'Your account';
  const subject = encodeURIComponent(`Account on hold: ${biz}`);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="hold-title" style={{
      // Same backdrop as the paywall: the app behind is dimmed and blurred.
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(10, 12, 8, 0.72)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 'max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom))',
      overflowY: 'auto',
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 440, padding: 28, display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'center' }}>
        <div style={{
          width: 48, height: 48, borderRadius: 99, margin: '0 auto',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--surface-2)', color: 'var(--fg-2)',
        }}><Icons.Lock size={22}/></div>
        <h1 id="hold-title" className="page-title" style={{ fontSize: 22, margin: 0 }}>This account is on hold</h1>
        <p style={{ fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.6, margin: 0 }}>
          We have paused this account while we review it. Your booking page, website and payments are off for now. Nothing has been deleted.
        </p>
        <p style={{ fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.6, margin: 0 }}>
          If you think this is a mistake, email us and we will sort it out.
        </p>
        <a className="btn btn-primary" href={`mailto:hello@joinivy.ai?subject=${subject}`}
          style={{ justifyContent: 'center', minHeight: 46, textDecoration: 'none' }}>
          <Icons.Mail size={15}/> Email hello@joinivy.ai
        </a>
        <button type="button" className="btn btn-outline" onClick={() => signOut()} style={{ justifyContent: 'center', minHeight: 46 }}>
          Sign out
        </button>
      </div>
    </div>
  );
}
