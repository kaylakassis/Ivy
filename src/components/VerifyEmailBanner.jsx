// Shown above the Topbar for unverified users. Has a Resend button.
import React, { useState } from 'react';
import { Icons } from './Icons.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';

export default function VerifyEmailBanner() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err,  setErr]  = useState(null);

  if (!user || user.email_verified_at) return null;

  const resend = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post('/auth/resend-verification');
      setSent(true);
      setTimeout(() => setSent(false), 4000);
    } catch (e) {
      setErr(e.message || 'Could not send right now');
      setTimeout(() => setErr(null), 4000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 24px',
      background: 'var(--accent-soft)',
      borderBottom: '1px solid var(--accent-tint)',
      color: 'var(--accent)',
      fontSize: 13,
    }}>
      <Icons.Mail size={15} sw={1.7} />
      <div style={{ flex: 1 }}>
        <strong>Confirm your email.</strong>{' '}
        <span style={{ color: 'var(--fg-2)' }}>
          We sent a link to <strong>{user.email}</strong>. Check your inbox (and spam folder).
        </span>
      </div>
      {sent ? (
        <span style={{ fontSize: 12, color: 'var(--ok)' }}>✓ Sent</span>
      ) : err ? (
        <span style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>
      ) : (
        <button onClick={resend} disabled={busy} className="btn btn-outline"
          style={{ padding: '5px 12px', fontSize: 12, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Sending…' : 'Resend email'}
        </button>
      )}
    </div>
  );
}
