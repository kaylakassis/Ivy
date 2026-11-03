// 2-step verification settings, shared by every account type: the owner's
// Account → Security card, the client portal profile (/me/profile) and the
// helper account page. Two methods, either or both:
//
//   Email codes        POST /auth/mfa/email-setup sends a code to the verified
//                      email; /auth/mfa/email-enable confirms it and turns it
//                      on (and returns 10 backup codes once, if there were
//                      none). /auth/mfa/disable turns it off with the password.
//   Authenticator app  POST /auth/totp/enroll gives an otpauth:// URI (shown as
//                      a QR code), the secret for manual entry and 10 backup
//                      codes shown once; /auth/totp/verify turns it on;
//                      /auth/totp/disable turns it off with the password.
//
// Sign-in is never changed until a code has been confirmed, and turning
// anything off needs the current password, so a stolen session can't.
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { Icons } from '../../components/Icons.jsx';

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };
const RESEND_COOLDOWN = 30;

export const TWO_STEP_PITCH = 'When you sign in, Ivy asks for a 6-digit code as well as your password, so someone who learns your password still cannot get in.';

// `bare`: render without the top divider (when it is the first thing in a card).
export default function TwoFactor({ bare = false }) {
  const { user, refresh } = useAuth();
  const appOn = !!user?.totp_enrolled_at;
  const emailOn = !!user?.mfa_email_enabled_at;
  const anyOn = appOn || emailOn;
  const verified = !!user?.email_verified_at;

  // idle | email-setup | email-off | backup | app-setup | app-off
  const [mode, setMode] = useState('idle');
  const [setup, setSetup] = useState(null); // app: { secret, otpauth, backupCodes }
  const [backupCodes, setBackupCodes] = useState(null); // from email-enable
  const [sentTo, setSentTo] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (!setup?.otpauth) { setQr(''); return; }
    QRCode.toDataURL(setup.otpauth, { margin: 1, width: 180 })
      .then(setQr)
      .catch(() => setQr(''));
  }, [setup]);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const reset = () => {
    setMode('idle'); setSetup(null); setBackupCodes(null); setCode(''); setPassword('');
    setErr(''); setBusy(false);
  };
  const open = (m) => { reset(); setDone(''); setMode(m); };

  // ── Email codes ──
  const sendSetupCode = async () => {
    setErr(''); setDone(''); setBusy(true);
    try {
      const r = await api.post('/auth/mfa/email-setup', {});
      if (r.alreadyOn) { await refresh(); reset(); return; }
      setSentTo(r.email || user?.email || '');
      setCode('');
      setMode('email-setup');
      setWait(r.cooldownSeconds || RESEND_COOLDOWN);
    } catch (e) {
      const ra = e.details?.retryAfterSeconds;
      if (e.status === 429 && ra && ra < 120) setWait(ra);
      setErr(e.message || 'Could not send a code.');
    } finally { setBusy(false); }
  };

  const confirmEmail = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await api.post('/auth/mfa/email-enable', { code });
      await refresh();
      if (Array.isArray(r.backupCodes) && r.backupCodes.length) {
        setBackupCodes(r.backupCodes); setCode(''); setBusy(false); setMode('backup');
        return;
      }
      reset();
      setDone('2-step verification is on. We will email you a code each time you sign in.');
    } catch (e2) { setErr(e2.message || 'That code did not match.'); setBusy(false); }
  };

  const disableEmail = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await api.post('/auth/mfa/disable', { password, method: 'email' });
      await refresh();
      reset();
      setDone(appOn ? 'Email codes are off. Your authenticator app still protects sign-in.' : '2-step verification is off.');
    } catch (e2) { setErr(e2.message || 'Could not turn it off.'); setBusy(false); }
  };

  // ── Authenticator app ──
  const startApp = async () => {
    setErr(''); setDone(''); setBusy(true);
    try {
      const r = await api.post('/auth/totp/enroll', {});
      setSetup(r); setMode('app-setup');
    } catch (e) { setErr(e.message || 'Could not start setup.'); }
    finally { setBusy(false); }
  };

  const verifyApp = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await api.post('/auth/totp/verify', { code });
      await refresh();
      reset();
      setDone('Your authenticator app is set up. Sign-in will ask for a code from it.');
    } catch (e2) { setErr(e2.message || 'That code did not match.'); setBusy(false); }
  };

  const disableApp = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await api.post('/auth/totp/disable', { password });
      await refresh();
      reset();
      setDone(emailOn ? 'Authenticator app removed. Email codes still protect sign-in.' : '2-step verification is off.');
    } catch (e2) { setErr(e2.message || 'Could not turn it off.'); setBusy(false); }
  };

  const copyCodes = async (codes) => {
    try { await navigator.clipboard.writeText((codes || []).join('\n')); setDone('Backup codes copied.'); }
    catch { /* clipboard unavailable; codes are still on screen */ }
  };

  const idle = mode === 'idle';

  return (
    <div style={bare ? undefined : { marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        2-step verification
        {anyOn
          ? <span style={pill('var(--accent)', 'var(--accent-soft, rgba(0,200,120,0.15))')}>On</span>
          : <span style={pill('var(--muted)', 'var(--surface-2)')}>Off</span>}
      </div>
      {anyOn ? (
        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>
          Sign-in asks for a code as well as your password.
        </div>
      ) : (
        <div style={{
          marginTop: 8, padding: '10px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
          background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
          border: '1px solid color-mix(in srgb, var(--accent) 25%, var(--border))', color: 'var(--fg-2)',
        }}>
          <strong style={{ color: 'var(--fg)' }}>Recommended.</strong> {TWO_STEP_PITCH} Email codes need no extra app.
        </div>
      )}

      {/* Method rows */}
      <MethodRow
        icon={<Icons.Mail size={16}/>}
        title="Email me a code"
        on={emailOn}
        hint={emailOn
          ? `Codes go to ${user?.email || 'your email'}.`
          : verified
            ? 'We email you a 6-digit code when you sign in. No extra app needed.'
            : 'Confirm your email address first, using the link we sent you. Then you can turn this on.'}
        action={idle && (emailOn
          ? <button type="button" className="btn btn-outline" onClick={() => open('email-off')} style={btnS}>Turn off</button>
          : <button type="button" className={'btn ' + (anyOn ? 'btn-outline' : 'btn-primary')} disabled={busy || !verified} onClick={sendSetupCode} style={btnS}>
            {busy ? 'Sending…' : 'Turn on'}
          </button>)}
      />
      <MethodRow
        icon={<Icons.Lock size={16}/>}
        title="Authenticator app"
        on={appOn}
        hint={appOn
          ? 'Codes come from your authenticator app.'
          : 'Use an app such as Google Authenticator, Authy or 1Password.'}
        action={idle && (appOn
          ? <button type="button" className="btn btn-outline" onClick={() => open('app-off')} style={btnS}>Turn off</button>
          : <button type="button" className="btn btn-outline" disabled={busy} onClick={startApp} style={btnS}>Set up</button>)}
      />

      {done && idle && (
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--accent)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <Icons.Check size={14} sw={2.2} style={{ flexShrink: 0, marginTop: 2 }}/> <span>{done}</span>
        </div>
      )}

      {mode === 'email-setup' && (
        <form onSubmit={confirmEmail} style={panelS}>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            We sent a 6-digit code to <strong>{sentTo || 'your email'}</strong>. Enter it to turn on email codes. It works for 10 minutes.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" aria-label="Code from your email"
              style={{ ...mono, width: 140, letterSpacing: 3, fontSize: 16 }} required autoFocus/>
            <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Turn on'}</button>
            <button type="button" className="btn btn-outline" onClick={reset} disabled={busy}>Cancel</button>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
            No email? Check your spam folder, or{' '}
            <button type="button" onClick={sendSetupCode} disabled={busy || wait > 0}
              style={{ ...linkS, ...(busy || wait > 0 ? { color: 'var(--muted)', textDecoration: 'none', cursor: 'default' } : {}) }}>
              {wait > 0 ? `send a new code in ${wait}s` : 'send a new code'}
            </button>.
            <br/>Sign-in is not changed until this code is accepted.
          </div>
          {err && <div style={errS}>{err}</div>}
        </form>
      )}

      {mode === 'backup' && backupCodes && (
        <div style={panelS}>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <strong>Email codes are on.</strong> Save these backup codes somewhere safe. Each one works once if you ever cannot get to your email. They are shown only now.
          </div>
          <BackupCodes codes={backupCodes}/>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn btn-outline" onClick={() => copyCodes(backupCodes)}>Copy codes</button>
            <button type="button" className="btn btn-primary" onClick={() => { reset(); setDone('2-step verification is on. We will email you a code each time you sign in.'); }}>I saved them</button>
            {done && <span style={{ fontSize: 12.5, color: 'var(--accent)' }}>{done}</span>}
          </div>
        </div>
      )}

      {mode === 'email-off' && (
        <form onSubmit={disableEmail} style={panelS}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            {appOn
              ? 'Confirm your password to stop email codes. Your authenticator app stays on.'
              : 'Confirm your password to turn off 2-step verification. Your backup codes stop working too.'}
          </div>
          <PasswordRow password={password} setPassword={setPassword} busy={busy} onCancel={reset}/>
          {err && <div style={errS}>{err}</div>}
        </form>
      )}

      {mode === 'app-setup' && setup && (
        <form onSubmit={verifyApp} style={{ ...panelS, gap: 16 }}>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {qr
              ? <img src={qr} alt="QR code for your authenticator app" width={180} height={180} style={{ borderRadius: 10, background: '#fff', padding: 6, flex: '0 0 auto' }}/>
              : <div style={{ width: 180, height: 180, borderRadius: 10, background: 'var(--surface-2)' }}/>}
            <div style={{ flex: 1, minWidth: 220, fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>1. Scan this with your authenticator app</div>
              <div style={{ color: 'var(--muted)' }}>Or enter this key by hand:</div>
              <div style={{ ...mono, fontSize: 13, wordBreak: 'break-all', marginTop: 4, userSelect: 'all' }}>{setup.secret}</div>
              <div style={{ fontWeight: 600, margin: '14px 0 6px' }}>2. Save your backup codes</div>
              <div style={{ color: 'var(--muted)' }}>Each works once if you lose your phone. They are shown only now{emailOn ? ' and replace any you saved before' : ''}.</div>
              <BackupCodes codes={setup.backupCodes}/>
              <button type="button" className="btn btn-outline" onClick={() => copyCodes(setup.backupCodes)} style={{ marginTop: 8, padding: '6px 12px', fontSize: 12.5 }}>
                Copy codes
              </button>
              {done && <span style={{ marginLeft: 10, fontSize: 12.5, color: 'var(--accent)' }}>{done}</span>}
            </div>
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>3. Enter the 6-digit code from the app to finish</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" aria-label="Code from your app"
                style={{ ...mono, width: 140, letterSpacing: 3, fontSize: 16 }} required/>
              <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Turn on'}</button>
              <button type="button" className="btn btn-outline" onClick={reset} disabled={busy}>Cancel</button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>Sign-in is not changed until this code is accepted.</div>
          </div>
          {err && <div style={errS}>{err}</div>}
        </form>
      )}

      {mode === 'app-off' && (
        <form onSubmit={disableApp} style={panelS}>
          <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            {emailOn
              ? 'Confirm your password to remove the authenticator app. Email codes stay on.'
              : 'Confirm your password to turn off 2-step verification. Your backup codes stop working too.'}
          </div>
          <PasswordRow password={password} setPassword={setPassword} busy={busy} onCancel={reset}/>
          {err && <div style={errS}>{err}</div>}
        </form>
      )}

      {idle && err && <div style={{ ...errS, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function MethodRow({ icon, title, on, hint, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
      <span style={{
        width: 32, height: 32, borderRadius: 9, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: on ? 'var(--accent-soft, rgba(0,200,120,0.15))' : 'var(--surface-2)',
        color: on ? 'var(--accent)' : 'var(--muted)',
      }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 550, display: 'flex', gap: 6, alignItems: 'center' }}>
          {title}
          {on && <Icons.Check size={13} sw={2.4} stroke="var(--accent)"/>}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{hint}</div>
      </div>
      {action || null}
    </div>
  );
}

function BackupCodes({ codes }) {
  return (
    <div style={{ ...mono, fontSize: 12.5, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 14px', marginTop: 6, padding: 10, borderRadius: 8, background: 'var(--surface-2)', maxWidth: 320 }}>
      {(codes || []).map((c) => <span key={c}>{c}</span>)}
    </div>
  );
}

function PasswordRow({ password, setPassword, busy, onCancel }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <input className="input" type="password" autoComplete="current-password" value={password}
        onChange={(e) => setPassword(e.target.value)} placeholder="Current password" aria-label="Current password"
        style={{ width: 220, maxWidth: '100%', fontSize: 16 }} required autoFocus/>
      <button type="submit" className="btn btn-primary" disabled={busy || !password}>{busy ? '…' : 'Turn off'}</button>
      <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
  );
}

const pill = (fg, bg) => ({ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: bg, color: fg });
const btnS = { whiteSpace: 'nowrap', padding: '7px 12px', fontSize: 13 };
const panelS = { marginTop: 14, display: 'grid', gap: 10, padding: 14, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' };
const errS = { fontSize: 13, color: 'var(--danger, #e5484d)' };
const linkS = { color: 'var(--accent)', fontWeight: 550, padding: 0, font: 'inherit', cursor: 'pointer', textDecoration: 'underline', background: 'none', border: 0 };
