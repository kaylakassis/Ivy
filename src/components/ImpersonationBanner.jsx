// Sticky banner that surfaces whenever the current session is an
// impersonated one (admin viewing as another user). Renders nothing
// when /api/auth/me returns no `impersonating` block - i.e. for
// regular users this component is invisible and free.
import React, { useState } from 'react';
import { Icons } from './Icons.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';

export default function ImpersonationBanner() {
  const { impersonating, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  if (!impersonating) return null;

  const stop = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/admin/impersonate/stop', {});
      await refresh();
      // Bounce back to /admin so the operator lands somewhere useful.
      window.location.href = '/admin';
    } catch (e) {
      setErr(e.message || 'Could not stop impersonating');
      setBusy(false);
    }
  };

  return (
    <div role="status" aria-live="polite" style={{
      position: 'sticky', top: 0, zIndex: 250,
      background: 'var(--warn, #C97A2E)',
      color: '#fff',
      padding: '8px 14px',
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      fontSize: 13, fontWeight: 550,
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    }}>
      <Icons.Settings size={14} sw={2}/>
      <span>
        Impersonating <strong>{impersonating.targetEmail}</strong>
        {impersonating.actorEmail && <> (you're {impersonating.actorEmail})</>}
        . Anything you do here is logged.
      </span>
      <button onClick={stop} disabled={busy}
        style={{
          marginLeft: 'auto',
          padding: '8px 14px', minHeight: 36, borderRadius: 6, fontSize: 12.5,
          background: 'rgba(255,255,255,0.2)', color: '#fff',
          border: '1px solid rgba(255,255,255,0.4)',
          cursor: busy ? 'wait' : 'pointer',
        }}>
        {busy ? 'Stopping…' : 'Stop impersonating'}
      </button>
      {err && <span style={{ fontSize: 12 }}>{err}</span>}
    </div>
  );
}
