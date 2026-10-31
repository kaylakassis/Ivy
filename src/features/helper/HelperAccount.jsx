// /helper/account - the whole of a helper's settings: name, password
// (reset by email, same as owners), notifications, sign out, and
// deleting their own sign-in (which detaches them from the business and
// leaves the owner's staff record in place).
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { useHelper } from './helperContext.jsx';

export default function HelperAccount() {
  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 600 }}>
      <ProfileCard/>
      <PasswordCard/>
      <NotificationsCard/>
      <SignOutCard/>
      <DeleteCard/>
    </div>
  );
}

function Card({ title, hint, children }) {
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="metric-label" style={{ marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>{hint}</div>}
      {children}
    </div>
  );
}

function ProfileCard() {
  const { user, refresh: refreshUser } = useAuth();
  const { helps } = useHelper();
  const [name, setName] = useState(user?.name || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { setName(user?.name || ''); }, [user?.name]);
  const save = async () => {
    if (!name.trim()) { setMsg({ err: 'Your name is required' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.patch('/me/profile', { name: name.trim() });
      if (typeof refreshUser === 'function') await refreshUser();
      setMsg({ ok: 'Saved' });
    } catch (e) { setMsg({ err: e.message || 'Could not save' }); }
    finally { setBusy(false); }
  };
  return (
    <Card title="You" hint={helps.length ? `Helping at ${helps.map((h) => h.businessName).join(', ')}.` : null}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 4 }}>Name</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} className="input" style={{ flex: 1, fontSize: 14 }}/>
        <button className="btn btn-primary" disabled={busy || name.trim() === (user?.name || '')} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 10 }}>Signed in as {user?.email}</div>
      {msg?.ok && <div style={{ fontSize: 12.5, color: 'var(--ok)', marginTop: 6 }}>{msg.ok}</div>}
      {msg?.err && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 6 }}>{msg.err}</div>}
    </Card>
  );
}

function PasswordCard() {
  const nav = useNavigate();
  return (
    <Card title="Password" hint="We email you a link to set a new password.">
      <button className="btn btn-outline" onClick={() => nav('/forgot-password')}>Reset password</button>
    </Card>
  );
}

// Per-type toggles on the same prefs the owner Account page uses
// (/api/me/notifications). Helpers only ever receive 'bookings'.
function NotificationsCard() {
  const [prefs, setPrefs] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/me/notifications')
      .then((r) => live && setPrefs({ push: r.pushPrefs || {}, email: r.emailPrefs || {} }))
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, []);
  const toggle = async (channel, type) => {
    const next = !(prefs[channel][type] !== false);
    setPrefs((p) => ({ ...p, [channel]: { ...p[channel], [type]: next } }));
    try {
      await api.patch('/me/notifications', channel === 'push' ? { pushPrefs: { [type]: next } } : { emailPrefs: { [type]: next } });
    } catch (e) {
      setPrefs((p) => ({ ...p, [channel]: { ...p[channel], [type]: !next } }));
      setErr(e.message || 'Could not update');
    }
  };
  return (
    <Card title="Notifications" hint="New sessions assigned to you, changes to them, and reminders before they start.">
      {!prefs && !err && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
      {prefs && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ToggleRow label="Push notifications" hint="On this device, when the app is installed." on={prefs.push.bookings !== false} onToggle={() => toggle('push', 'bookings')}/>
          <ToggleRow label="Email" hint="Booking emails about your sessions." on={prefs.email.bookings !== false} onToggle={() => toggle('email', 'bookings')}/>
        </div>
      )}
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
    </Card>
  );
}

function ToggleRow({ label, hint, on, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 550 }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{hint}</div>}
      </div>
      <button type="button" role="switch" aria-checked={on} onClick={onToggle}
        className={'btn ' + (on ? 'btn-primary' : 'btn-outline')} style={{ minWidth: 60, justifyContent: 'center', padding: '6px 12px', fontSize: 12.5 }}>
        {on ? 'On' : 'Off'}
      </button>
    </div>
  );
}

function SignOutCard() {
  const { signOut } = useAuth();
  const nav = useNavigate();
  return (
    <Card title="Session">
      <button className="btn btn-outline" onClick={async () => { await signOut(); nav('/signin', { replace: true }); }}>
        <Icons.Arrow size={14}/> Log out
      </button>
    </Card>
  );
}

function DeleteCard() {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/account/delete', { confirmEmail: confirm.trim() });
      await signOut().catch(() => {});
      nav('/signin', { replace: true });
    } catch (e) { setErr(e.message || 'Could not delete'); setBusy(false); }
  };
  return (
    <Card title="Delete my sign-in" hint="Removes your Ivy sign-in and detaches you from the business. Their records of past sessions stay with them.">
      {!open ? (
        <button className="btn btn-outline" style={{ color: 'var(--danger)' }} onClick={() => setOpen(true)}>
          <Icons.Trash size={14}/> Delete my account
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13 }}>Type <strong>{user?.email}</strong> to confirm.</div>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="input" placeholder={user?.email} style={{ fontSize: 14 }}/>
          {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}
              disabled={busy || confirm.trim().toLowerCase() !== (user?.email || '').toLowerCase()} onClick={go}>
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
