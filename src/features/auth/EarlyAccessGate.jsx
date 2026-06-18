// Temporary password gate that wraps the AuthPage. When the operator
// enables it in /admin → Settings, every visitor to /signin or /signup
// sees this screen first. Children render only after the visitor
// supplies the right password (and gets the ea_pass cookie set).
//
// When the gate is OFF, this component is invisible - it just renders
// children directly. Removal plan: delete this file + the import in
// AuthPage.jsx; no other code references it.
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import AuthShell from './AuthShell.jsx';

export default function EarlyAccessGate({ children }) {
  // null while we're checking; objects after.
  const [status, setStatus] = useState(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/early-access/status')
      .then((r) => { if (live) setStatus(r); })
      .catch(() => { if (live) setStatus({ enabled: false, unlocked: true }); });
    return () => { live = false; };
  }, []);

  if (status === null) {
    // Don't flash the children - show nothing while we figure out
    // whether the gate is on. The check is fast (single SELECT).
    return null;
  }

  if (!status.enabled || status.unlocked) return children;

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (!password) { setErr('Enter the access password'); return; }
    setBusy(true);
    try {
      const r = await api.post('/early-access/verify', { password });
      if (r.unlocked) setStatus({ enabled: true, unlocked: true });
    } catch (e2) {
      setErr(e2.message || 'Wrong password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 14,
        padding: '6px 0',
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--accent-soft)', color: 'var(--accent)',
          marginBottom: 4,
        }}>
          <Icons.Lock size={20} sw={1.7}/>
        </div>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 28, margin: 0,
          fontStyle: 'italic', fontWeight: 600,
        }}>
          Early access
        </h1>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
          Ivy OS is in private beta. Enter the access password to continue.
        </p>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Access password"
            autoFocus
            autoComplete="off"
            className="input"
            style={{ padding: '11px 13px', fontSize: 14 }}
          />
          {err && (
            <div style={{
              color: 'var(--danger)', fontSize: 12.5, padding: '6px 2px',
            }}>{err}</div>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !password}
            style={{ padding: '11px 16px', marginTop: 4 }}
          >
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>

        <p style={{
          margin: '14px 0 0', fontSize: 11.5, color: 'var(--muted)',
        }}>
          Don't have the password? Email the team to get on the list.
        </p>
      </div>
    </AuthShell>
  );
}
