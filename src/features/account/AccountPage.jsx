// /account — settings page. Currently exposes the GDPR controls:
//   • Profile (read-only summary of the authenticated user)
//   • Export your data — downloads a JSON dump of every workspace row
//   • Delete account — irreversible; requires re-typing the email
//
// Future tabs (billing, team, notifications) will mount alongside.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useAuth } from '../../lib/auth.jsx';

export default function AccountPage() {
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const [busyExport, setBusyExport] = useState(false);
  const [exportErr, setExportErr]   = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const downloadExport = async () => {
    setBusyExport(true);
    setExportErr(null);
    try {
      const res = await fetch('/api/account/export', { credentials: 'include' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `thryve-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportErr(err.message || 'Could not export');
    } finally {
      setBusyExport(false);
    }
  };

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Account</h2>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
          Manage your profile, your data, and the rest of your account.
        </div>
      </div>

      {/* Profile */}
      <div className="card" style={{ padding: 22 }}>
        <div className="metric-label" style={{ marginBottom: 12 }}>Profile</div>
        <Row label="Name"  value={user?.name || '—'}/>
        <Row label="Email" value={user?.email || '—'}/>
        <Row label="Email verified" value={user?.email_verified_at ? 'Yes' : 'No'}/>
        <Row label="Member since" value={user?.created_at ? new Date(user.created_at).toLocaleDateString([], { dateStyle: 'long' }) : '—'}/>
      </div>

      {/* Export */}
      <div className="card" style={{ padding: 22 }}>
        <div className="metric-label" style={{ marginBottom: 8 }}>Your data</div>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>Export everything</h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Download a single JSON file with every row tied to your workspace —
          clients, invoices, messages, documents, calendar, goals, rewards,
          and Ivy chats. Yours to keep, search, or import elsewhere.
        </p>
        {exportErr && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 12,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{exportErr}</div>
        )}
        <button className="btn btn-outline" onClick={downloadExport} disabled={busyExport}>
          <Icons.Doc size={14}/> {busyExport ? 'Preparing…' : 'Download my data'}
        </button>
      </div>

      {/* Danger zone */}
      <div className="card" style={{ padding: 22, borderColor: 'var(--danger)' }}>
        <div className="metric-label" style={{ marginBottom: 8, color: 'var(--danger)' }}>Danger zone</div>
        <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>Delete your account</h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Permanently removes your account, your workspace, and every row tied
          to it — clients, invoices, documents, messages, the lot. This is{' '}
          <strong>irreversible</strong> and takes effect immediately. We don't
          keep backups beyond 30 days, so the data is truly gone after that.
        </p>
        <button className="btn btn-outline" onClick={() => setDeleteOpen(true)}
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          <Icons.Trash size={14}/> Delete my account
        </button>
      </div>

      {deleteOpen && (
        <DeleteAccountModal
          email={user?.email}
          onCancel={() => setDeleteOpen(false)}
          onConfirmed={async () => {
            // Auth state cleared server-side; refresh local state and bounce
            // to the marketing surface.
            await refresh();
            nav('/signin', { replace: true });
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      gap: 12, padding: '8px 0', borderTop: '1px solid var(--border)',
    }}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
      <span style={{ fontSize: 13.5, color: 'var(--fg)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function DeleteAccountModal({ email, onCancel, onConfirmed }) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const matches = confirm.trim().toLowerCase() === (email || '').toLowerCase();

  const submit = async (e) => {
    e.preventDefault();
    if (!matches) { setErr("Email doesn't match"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmEmail: confirm.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onConfirmed();
    } catch (ex) {
      setErr(ex.message || 'Could not delete account');
      setBusy(false);
    }
  };

  return (
    <div onClick={onCancel} role="dialog" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
        className="card" style={{ width: '100%', maxWidth: 460, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'rgba(155,44,44,0.12)', color: 'var(--danger)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Trash size={16}/></div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>Delete account?</h3>
          <button type="button" onClick={onCancel} className="btn btn-ghost" style={{ padding: 6 }}><Icons.X size={15}/></button>
        </div>

        <p style={{ margin: '4px 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          This is permanent. Your workspace, every client, invoice, document,
          message, and AI conversation will be deleted. We won't be able to
          recover it.
        </p>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          <span style={{ fontSize: 12, fontWeight: 550, color: 'var(--fg-2)' }}>
            To confirm, type your email: <span style={{ color: 'var(--fg)' }}>{email}</span>
          </span>
          <input type="email" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            autoFocus required autoComplete="off"
            placeholder={email}
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1px solid ' + (confirm.length > 0 && !matches ? 'var(--danger)' : 'var(--border-strong)'),
              background: 'var(--surface)', outline: 'none',
              fontSize: 14, color: 'var(--fg)',
            }}/>
        </label>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 12,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-outline" onClick={onCancel}
            style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button type="submit" className="btn btn-primary"
            disabled={busy || !matches}
            style={{
              flex: 2, justifyContent: 'center',
              background: 'var(--danger)', borderColor: 'var(--danger)',
              color: '#fff',
              opacity: (busy || !matches) ? 0.6 : 1,
            }}>
            {busy ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </form>
    </div>
  );
}
