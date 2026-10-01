// Two-factor authentication (authenticator app) for the owner's sign-in.
// The server side has existed for a while (api/auth/totp/*); this is the
// first screen that can actually turn it on and off.
//
// Enrol: POST /auth/totp/enroll gives an otpauth:// URI (rendered as a QR
// code here), the base32 secret for manual entry, and 10 one-time backup
// codes that are shown exactly once. Sign-in is NOT gated until the owner
// proves they can read a code: POST /auth/totp/verify flips it on.
// Disable needs the current password, so a stolen session can't switch it off.
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { Icons } from '../../components/Icons.jsx';

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };

export default function TwoFactor() {
  const { user, refresh } = useAuth();
  const enabled = !!user?.totp_enrolled_at;
  const [mode, setMode] = useState('idle'); // idle | enrolling | disabling
  const [setup, setSetup] = useState(null); // { secret, otpauth, backupCodes }
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!setup?.otpauth) { setQr(''); return; }
    QRCode.toDataURL(setup.otpauth, { margin: 1, width: 180 })
      .then(setQr)
      .catch(() => setQr(''));
  }, [setup]);

  const reset = () => { setMode('idle'); setSetup(null); setCode(''); setPassword(''); setErr(''); setBusy(false); };

  const start = async () => {
    setErr(''); setDone(''); setBusy(true);
    try {
      const r = await api.post('/auth/totp/enroll', {});
      setSetup(r); setMode('enrolling');
    } catch (e) { setErr(e.message || 'Could not start setup.'); }
    finally { setBusy(false); }
  };

  const verify = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await api.post('/auth/totp/verify', { code });
      await refresh();
      reset();
      setDone('Two-factor is on. You will be asked for a code each time you sign in.');
    } catch (e2) { setErr(e2.message || 'That code did not match.'); setBusy(false); }
  };

  const disable = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await api.post('/auth/totp/disable', { password });
      await refresh();
      reset();
      setDone('Two-factor is off.');
    } catch (e2) { setErr(e2.message || 'Could not turn off two-factor.'); setBusy(false); }
  };

  const copyCodes = async () => {
    try { await navigator.clipboard.writeText((setup?.backupCodes || []).join('\n')); setDone('Backup codes copied.'); }
    catch { /* clipboard unavailable; codes are still on screen */ }
  };

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            Two-factor authentication
            {enabled && (
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'var(--accent-soft, rgba(0,200,120,0.15))', color: 'var(--accent)' }}>On</span>
            )}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>
            {enabled
              ? 'A code from your authenticator app is required at sign-in, on top of your password.'
              : 'Add a second step at sign-in using an authenticator app such as Google Authenticator, Authy or 1Password.'}
          </div>
        </div>
        {mode === 'idle' && (
          <button type="button" className={'btn ' + (enabled ? 'btn-outline' : 'btn-primary')} disabled={busy}
            onClick={enabled ? () => { setErr(''); setDone(''); setMode('disabling'); } : start}
            style={{ whiteSpace: 'nowrap' }}>
            {busy ? '…' : enabled ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>

      {done && mode === 'idle' && (
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--accent)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <Icons.Check size={14} sw={2.2}/> {done}
        </div>
      )}

      {mode === 'enrolling' && setup && (
        <form onSubmit={verify} style={{ marginTop: 16, display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {qr
              ? <img src={qr} alt="QR code for your authenticator app" width={180} height={180} style={{ borderRadius: 10, background: '#fff', padding: 6, flex: '0 0 auto' }}/>
              : <div style={{ width: 180, height: 180, borderRadius: 10, background: 'var(--surface-2)' }}/>}
            <div style={{ flex: 1, minWidth: 220, fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>1. Scan this with your authenticator app</div>
              <div style={{ color: 'var(--muted)' }}>Or enter this key by hand:</div>
              <div style={{ ...mono, fontSize: 13, wordBreak: 'break-all', marginTop: 4, userSelect: 'all' }}>{setup.secret}</div>
              <div style={{ fontWeight: 600, margin: '14px 0 6px' }}>2. Save your backup codes</div>
              <div style={{ color: 'var(--muted)' }}>Each works once if you lose your phone. They are shown only now.</div>
              <div style={{ ...mono, fontSize: 12.5, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 14px', marginTop: 6, padding: 10, borderRadius: 8, background: 'var(--surface-2)' }}>
                {(setup.backupCodes || []).map((c) => <span key={c}>{c}</span>)}
              </div>
              <button type="button" className="btn btn-outline" onClick={copyCodes} style={{ marginTop: 8, padding: '6px 12px', fontSize: 12.5 }}>
                Copy codes
              </button>
              {done && <span style={{ marginLeft: 10, fontSize: 12.5, color: 'var(--accent)' }}>{done}</span>}
            </div>
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>3. Enter the 6-digit code from the app to finish</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456"
                style={{ ...mono, width: 140, letterSpacing: 3, fontSize: 16 }} required/>
              <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Turn on'}</button>
              <button type="button" className="btn btn-outline" onClick={reset} disabled={busy}>Cancel</button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>Sign-in is not changed until this code is accepted.</div>
          </div>
          {err && <div style={{ fontSize: 13, color: 'var(--danger, #e5484d)' }}>{err}</div>}
        </form>
      )}

      {mode === 'disabling' && (
        <form onSubmit={disable} style={{ marginTop: 14, display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>Confirm your password to turn two-factor off. Your backup codes stop working too.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" type="password" autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder="Current password" style={{ width: 220 }} required/>
            <button type="submit" className="btn btn-primary" disabled={busy || !password}>{busy ? '…' : 'Turn off'}</button>
            <button type="button" className="btn btn-outline" onClick={reset} disabled={busy}>Cancel</button>
          </div>
          {err && <div style={{ fontSize: 13, color: 'var(--danger, #e5484d)' }}>{err}</div>}
        </form>
      )}

      {mode === 'idle' && err && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--danger, #e5484d)' }}>{err}</div>}
    </div>
  );
}
