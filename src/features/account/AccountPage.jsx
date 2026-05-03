// /account — settings page. Currently exposes the GDPR controls:
//   • Profile (read-only summary of the authenticated user)
//   • Export your data — downloads a JSON dump of every workspace row
//   • Delete account — irreversible; requires re-typing the email
//   • (Super-admin only) Admin panel: run migrations, test email, etc.
//
// Future tabs (billing, team, notifications) will mount alongside.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api.js';

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

      {user?.isSuperAdmin && <AdminPanel/>}

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

// ---- Admin panel (visible only to SUPER_ADMIN_EMAIL) ----
// Replaces the curl playbook for the most common admin operations.
// Each button is a one-shot fetch with a tiny status indicator below it.
function AdminPanel() {
  return (
    <div className="card" style={{
      padding: 22, borderColor: 'var(--accent)',
      borderWidth: 1, borderStyle: 'solid',
      background: 'color-mix(in srgb, var(--accent-soft) 60%, var(--surface))',
    }}>
      <div className="metric-label" style={{ marginBottom: 8, color: 'var(--accent)' }}>
        Admin
      </div>
      <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>Operator console</h3>
      <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        One-click versions of the curl commands. Visible to you because your
        email matches <code>SUPER_ADMIN_EMAIL</code>; hidden from everyone else.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ActionRow
          label="Run database migrations"
          desc="Applies any new schema changes from the latest deploy. Safe to re-run."
          fetcher={() => api.post('/admin/migrate')}
          actionLabel="Run migrate"
          successText={(r) => `Applied ${r.applied} statements.`}
        />
        <ActionRow
          label="Check email-domain status"
          desc="Pulls Resend's verification state for your sending domains."
          fetcher={() => api.get('/admin/email-status')}
          actionLabel="Check status"
          successText={(r) => {
            if (!r.domains?.length) return `No domains in Resend yet. From: ${r.from}`;
            return r.domains.map((d) => `${d.name}: ${d.status}`).join(' · ');
          }}
        />
        <SendTestEmailRow/>
        <ActionRow
          label="Trigger welcome-email cron now"
          desc="Sends any due welcome-sequence beats to eligible users immediately."
          fetcher={() => api.post('/cron/welcome-emails')}
          actionLabel="Run now"
          successText={(r) => {
            const total = Object.values(r.summary || {}).reduce((s, v) => s + (v?.sent || 0), 0);
            return `Sent ${total} email${total === 1 ? '' : 's'} across all beats.`;
          }}
        />
        <ActionRow
          label="Trigger booking-reminder cron now"
          desc="Forces an immediate scan of upcoming bookings for due reminders."
          fetcher={() => api.post('/cron/booking-reminders')}
          actionLabel="Run now"
          successText={(r) => `Scanned ${r.scanned}, sent ${r.sent}, failed ${r.failed}.`}
        />
      </div>
    </div>
  );
}

function ActionRow({ label, desc, fetcher, actionLabel, successText }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const run = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetcher();
      setResult(successText ? successText(r) : 'OK');
    } catch (e) {
      setErr(e.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      padding: '12px 14px', borderRadius: 10,
      background: 'var(--surface)', border: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
    }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{desc}</div>
        {result && (
          <div style={{ fontSize: 11.5, color: 'var(--ok)', marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icons.Check size={11} sw={2.4}/> {result}
          </div>
        )}
        {err && (
          <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 6 }}>
            {err}
          </div>
        )}
      </div>
      <button onClick={run} disabled={busy}
        className="btn btn-outline" style={{ padding: '6px 12px', fontSize: 12 }}>
        {busy ? 'Running…' : actionLabel}
      </button>
    </div>
  );
}

function SendTestEmailRow() {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const run = async () => {
    if (!to.trim()) { setErr('Enter an email'); return; }
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await api.post('/admin/email-test', { to: to.trim() });
      setResult(`Sent. Check ${to} in a minute (incl. spam folder).`);
    } catch (e) {
      setErr(e.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      padding: '12px 14px', borderRadius: 10,
      background: 'var(--surface)', border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>Send test email</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
          Sends a deliverability-check email through the same path the rest of the app uses.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input type="email" value={to} onChange={(e) => setTo(e.target.value)}
          placeholder="you@example.com"
          style={{
            flex: 1, minWidth: 200, padding: '8px 12px', borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
            color: 'var(--fg)', fontSize: 13, outline: 'none',
          }}/>
        <button onClick={run} disabled={busy || !to.trim()}
          className="btn btn-outline" style={{ padding: '6px 12px', fontSize: 12 }}>
          {busy ? 'Sending…' : 'Send test'}
        </button>
      </div>
      {result && (
        <div style={{ fontSize: 11.5, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icons.Check size={11} sw={2.4}/> {result}
        </div>
      )}
      {err && (
        <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>
      )}
    </div>
  );
}
