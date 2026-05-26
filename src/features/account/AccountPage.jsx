// /account — settings page. Currently exposes the GDPR controls:
//   • Profile (read-only summary of the authenticated user)
//   • Export your data — downloads a JSON dump of every workspace row
//   • Delete account — irreversible; requires re-typing the email
//   • (Super-admin only) Admin panel: run migrations, test email, etc.
//
// Future tabs (billing, team, notifications) will mount alongside.
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { useUserContext } from '../../lib/userContext.jsx';
import { api } from '../../lib/api.js';
import { useIntervalWhenVisible } from '../../lib/useIntervalWhenVisible.js';
import {
  pushSupported, permissionState, getSubscription,
  subscribePush, unsubscribePush,
} from '../../lib/push.js';

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

      <BrandingCard/>

      <SubscriptionCard/>

      <ReferralCard/>

      <NotificationsCard/>

      <SupportCard/>

      <WalkthroughCard/>

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
          label="Trigger booking-reminder cron now"
          desc="Forces an immediate scan of upcoming bookings for due reminders."
          fetcher={() => api.post('/cron/booking-reminders')}
          actionLabel="Run now"
          successText={(r) => `Scanned ${r.scanned}, sent ${r.sent}, failed ${r.failed}.`}
        />
        <ActionRow
          label="Trigger document-reminder cron now"
          desc="Pings owners (and clients) about documents still unsigned 3+ days after sending."
          fetcher={() => api.post('/cron/doc-reminders')}
          actionLabel="Run now"
          successText={(r) => `Scanned ${r.scanned}, pinged ${r.pinged}.`}
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

// Referral panel — "refer one, get one." Owners set a custom code,
// share their link, and earn a free month for every referred user who
// becomes paying. Renders for owners only.
function ReferralCard() {
  const { ctx } = useUserContext();
  const [data, setData]   = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    api.get('/referrals')
      .then((r) => { if (live) { setData(r); setDraft(r.code || ''); } })
      .catch(() => { if (live) setData({ code: null, stats: {}, rewardCents: 3900 }); });
    return () => { live = false; };
  }, []);

  // Owner-only program.
  if (!ctx?.isOwner) return null;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.put('/referrals', { code: draft });
      setData(r);
      setDraft(r.code);
    } catch (e) {
      setErr(e.message || 'Could not save code');
    } finally { setBusy(false); }
  };

  const copyLink = async () => {
    if (!data?.link) return;
    try {
      await navigator.clipboard.writeText(data.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — ignore */ }
  };

  const months = data?.stats?.rewarded || 0;
  const inputStyle = {
    padding: '10px 12px', borderRadius: 10,
    border: '1px solid var(--border-strong)',
    background: 'var(--surface)', outline: 'none',
    fontSize: 14, color: 'var(--fg)',
  };

  return (
    <div className="card" style={{ padding: 22 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>Refer a business, get a free month</div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Share your code with another business owner. When they subscribe, your
        next billing cycle is on us - one free month for every business you
        refer. It stacks.
      </p>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: 18 }}>
        <Stat label="Referred"  value={data?.stats?.referred ?? 0}/>
        <Stat label="Subscribed" value={data?.stats?.converted ?? 0}/>
        <Stat label="Free months earned" value={months}/>
      </div>

      <label style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
        Your referral code
      </label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
          placeholder="e.g. SARAH-HAIR"
          maxLength={40}
          style={{ ...inputStyle, flex: 1, minWidth: 160, textTransform: 'uppercase' }}/>
        <button className="btn btn-primary" onClick={save}
          disabled={busy || !draft.trim() || draft.trim() === (data?.code || '')}
          style={{ padding: '9px 16px', fontSize: 13 }}>
          {busy ? 'Saving…' : (data?.code ? 'Update' : 'Set code')}
        </button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 10 }}>{err}</div>}

      {data?.link && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={{
            flex: 1, minWidth: 200, padding: '9px 12px', borderRadius: 8,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            fontSize: 12.5, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{data.link}</code>
          <button className="btn btn-outline" onClick={copyLink} style={{ padding: '9px 14px', fontSize: 13 }}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 600, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

// Subscription panel — shows current state for owners and links to the
// Stripe billing portal when there's a customer record. For client-only
// Pre-checkout auto-renewal disclosure. California SB-313 and the FTC
// ROSCA rule both require recurring-charge consumers to see, BEFORE
// authorizing the first charge, (1) renewal cadence, (2) renewal
// price source, (3) how to cancel. Stripe Checkout shows the price on
// the next page; we own the framing here so the consent is clear.
// Owners click Subscribe → this modal → Continue → Stripe Checkout.
function AutoRenewalDisclosureModal({ onCancel, onConfirm, busy }) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="auto-renew-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(20, 18, 14, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}>
      <div className="card" style={{
        maxWidth: 460, padding: 28, background: 'var(--surface)',
        boxShadow: '0 24px 60px rgba(0,0,0,0.18)',
      }}>
        <h2 id="auto-renew-title" style={{
          margin: '0 0 8px', fontFamily: 'var(--font-display)',
          fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em',
        }}>Confirm your subscription</h2>
        <p style={{ margin: '0 0 16px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Before you continue to Stripe, here's the plain-English version:
        </p>
        <ul style={{ margin: '0 0 18px 18px', padding: 0, fontSize: 13.5, color: 'var(--fg)', lineHeight: 1.65 }}>
          <li><strong>Auto-renews.</strong> Your card is charged on the same day each billing period (monthly or annual — Stripe's next page shows which).</li>
          <li><strong>Price.</strong> The amount you'll be charged is shown on Stripe's checkout page. It doesn't change without notice.</li>
          <li><strong>Cancel anytime.</strong> From <em>Account → Manage subscription</em> here. You keep access through the end of the current billing period; no partial refunds.</li>
          <li><strong>Receipts</strong> are emailed to you after every successful charge.</li>
        </ul>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? 'Redirecting…' : 'Agree and continue to payment'}
          </button>
        </div>
      </div>
    </div>
  );
}

// users it renders nothing (no business workspace to subscribe).
function SubscriptionCard() {
  const { ctx, refresh } = useUserContext();
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  // CA SB-313 + FTC ROSCA: auto-renewal terms must be disclosed
  // clearly + conspicuously BEFORE the customer authorizes the
  // charge. Stripe Checkout shows the price; we own the renewal-
  // cadence + cancellation-method explanation. confirmingSubscribe
  // holds the click while the disclosure modal is up.
  const [confirmingSubscribe, setConfirmingSubscribe] = useState(false);

  if (!ctx?.isOwner) return null;
  const sub = ctx.subscription || { status: 'inactive', isActive: false };

  const openPortal = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/billing/portal', {});
      if (!r.url) throw new Error('No portal URL returned');
      window.location.href = r.url;
    } catch (e) {
      setErr(e.message || 'Could not open billing portal');
      setBusy(false);
    }
  };

  // Triggered when the owner clicks Subscribe/Resubscribe — opens the
  // disclosure modal instead of jumping straight to Stripe. The actual
  // redirect happens in confirmSubscribe below after they accept.
  const subscribeNow = () => {
    setErr(null);
    setConfirmingSubscribe(true);
  };

  const confirmSubscribe = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/billing/checkout', {});
      if (!r.url) throw new Error('No checkout URL returned');
      window.location.href = r.url;
    } catch (e) {
      setErr(e.message || 'Could not open checkout');
      setBusy(false);
      setConfirmingSubscribe(false);
    }
  };

  const startTrial = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/billing/start-trial', {});
      await refresh();
    } catch (e) {
      setErr(e.message || 'Could not start trial');
    } finally {
      setBusy(false);
    }
  };

  // Paid subscribers are "THRYVING" (the brand term for an active plan);
  // everyone else gets the plain state label.
  const statusLabel = {
    active:   'THRYVING',
    trialing: 'Free trial',
    past_due: 'Past due',
    suspended:'Suspended',
    cancelled:'Cancelled',
    inactive: 'Inactive',
  }[sub.status] || sub.status;
  const tone =
    sub.status === 'active'    ? 'var(--ok)'
  : sub.status === 'trialing'  ? 'var(--accent)'
  : sub.status === 'past_due'  ? 'var(--warn)'
  : sub.status === 'suspended' ? 'var(--danger)'
  : 'var(--muted)';

  return (
    <div className="card" style={{ padding: 22 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>Subscription</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{
          padding: '3px 10px', borderRadius: 99,
          background: 'color-mix(in srgb, ' + tone + ' 14%, transparent)',
          color: tone, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}>{statusLabel}</span>
        {sub.daysRemaining != null && (sub.status === 'trialing' || sub.status === 'active') && (
          <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
            {sub.daysRemaining === 0
              ? 'Renews today'
              : `${sub.status === 'trialing' ? 'Trial ends' : 'Renews'} in ${sub.daysRemaining} day${sub.daysRemaining === 1 ? '' : 's'}`}
          </span>
        )}
      </div>

      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        {sub.status === 'active'
          ? 'Open the Stripe billing portal to update your card, view past invoices, or cancel.'
        : sub.status === 'past_due'
          ? "Stripe couldn't charge your card. Open the billing portal to update it — your access will resume automatically once the next attempt succeeds."
        : sub.status === 'trialing'
          ? `You're on the free trial. Subscribe any time to keep access after it ends.`
          : 'Subscribe to keep using the business app. The client portal stays free either way.'}
      </p>

      {err && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 12,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {sub.stripeCustomerId || sub.status === 'active' || sub.status === 'past_due' || sub.status === 'cancelled' ? (
          <button className="btn btn-outline" onClick={openPortal} disabled={busy}>
            {busy ? 'Opening…' : 'Manage subscription'} <Icons.Arrow size={12} sw={2}/>
          </button>
        ) : null}
        {!sub.isActive && (
          <button className="btn btn-primary" onClick={subscribeNow} disabled={busy}>
            {busy ? 'Redirecting…' : (sub.status === 'cancelled' ? 'Resubscribe' : 'Subscribe')} <Icons.Arrow size={12} sw={2}/>
          </button>
        )}
        {confirmingSubscribe && (
          <AutoRenewalDisclosureModal
            onCancel={() => setConfirmingSubscribe(false)}
            onConfirm={confirmSubscribe}
            busy={busy}
          />
        )}
        {!sub.isActive && !sub.trialEndsAt && (
          <button className="btn btn-ghost" onClick={startTrial} disabled={busy}
            style={{ color: 'var(--muted)' }}>
            Start 28-day free trial
          </button>
        )}
      </div>
    </div>
  );
}

// Push-notifications opt-in. Real `Notification.requestPermission()` only
// works inside a user gesture, so the toggle has to be a plain button —
// no auto-prompt on mount. Once granted, the browser remembers; we just
// reflect the current state on every render.
function NotificationsCard() {
  const [supported, setSupported] = useState(true);
  const [perm, setPerm]   = useState('default');
  const [active, setActive] = useState(false);
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState(null);
  const cardRef = useRef(null);
  const [searchParams] = useSearchParams();

  // Honor /account?tab=notifications (used by email unsubscribe links)
  // by scrolling the card into view on first paint.
  useEffect(() => {
    if (searchParams.get('tab') !== 'notifications') return;
    const node = cardRef.current;
    if (!node) return;
    const t = setTimeout(() => node.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    return () => clearTimeout(t);
  }, [searchParams]);

  const refresh = async () => {
    if (!pushSupported()) { setSupported(false); return; }
    setPerm(permissionState());
    try {
      const sub = await getSubscription();
      setActive(!!sub);
    } catch {
      setActive(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const enable = async () => {
    setBusy(true); setErr(null);
    try {
      await subscribePush();
      await refresh();
    } catch (e) {
      setErr(e.message || 'Could not enable notifications');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true); setErr(null);
    try {
      await unsubscribePush();
      await refresh();
    } catch (e) {
      setErr(e.message || 'Could not disable notifications');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={cardRef} id="notifications" className="card" style={{ padding: 22, scrollMarginTop: 80 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>Notifications</div>
      <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>Push notifications</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Get notified the moment something needs you — new messages, signed
        documents, paid invoices, booking confirmations, and reminders for
        clients who haven't completed their forms yet. We never use these for
        marketing.
      </p>

      {!supported && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
          background: 'var(--surface-2)', color: 'var(--fg-2)',
        }}>
          This browser doesn't support push notifications. Try Chrome, Edge,
          Firefox, or install THRYVE to your home screen on iOS.
        </div>
      )}

      {supported && perm === 'denied' && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)',
        }}>
          Notifications are blocked for this site. Open your browser's site
          settings, allow notifications for THRYVE, and reload this page.
        </div>
      )}

      {supported && perm !== 'denied' && (
        <>
          {err && (
            <div style={{
              padding: '8px 12px', borderRadius: 8, marginBottom: 12,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12.5,
            }}>{err}</div>
          )}
          {active ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: 'var(--ok)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <Icons.Check size={12} sw={2.4}/> Notifications are on for this device.
                </span>
                <button className="btn btn-outline" onClick={disable} disabled={busy}
                  style={{ padding: '6px 12px', fontSize: 12 }}>
                  {busy ? 'Turning off…' : 'Turn off on this device'}
                </button>
              </div>
              <NotificationPrefs/>
            </>
          ) : (
            <button className="btn btn-primary" onClick={enable} disabled={busy}>
              {busy ? 'Enabling…' : 'Enable notifications'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// Per-type opt-out toggles. Lives below the device-level enable/disable
// row so the workflow reads top-down: turn ON in this browser, then
// pick which notification types you want to receive. Each toggle PATCHes
// /api/me/notifications optimistically — server is authoritative on
// the next page load.
const PUSH_LABELS = {
  messages:  { label: 'Messages',  hint: 'New chat messages from clients (or businesses, if you\'re a client).' },
  bookings:  { label: 'Booking alerts',  hint: 'Whether you GET notified about new bookings + session reminders. (How far ahead reminders fire is set per service in Calendar → Services.)' },
  documents: { label: 'Documents', hint: 'Documents to sign, signatures completed, overdue reminders.' },
  payments:  { label: 'Payments',  hint: 'Invoices paid by clients via Stripe.' },
  support:   { label: 'Support',   hint: 'When THRYVE Support replies to your conversation.' },
};
const EMAIL_LABELS = {
  bookings:  { label: 'Booking alerts',  hint: 'Whether confirmation / reminder / cancellation emails are sent. (Reminder timing is per service in Calendar → Services.)' },
  invoices:  { label: 'Invoices',  hint: 'Invoices and quotes you receive, plus paid-receipt emails.' },
  documents: { label: 'Documents', hint: 'Signature requests + reminders when a document is waiting.' },
  messages:  { label: 'Messages',  hint: 'When the other side of a chat thread replies.' },
  marketing: { label: 'Reviews & announcements', hint: 'Review prompts after sessions, occasional product updates.' },
  billing:   { label: 'Subscription billing', hint: 'Renewal reminders + cancellation confirmations. Payment failures always send.' },
};

function NotificationPrefs() {
  const [pushPrefs, setPushPrefs] = useState(null);
  const [emailPrefs, setEmailPrefs] = useState(null);
  const [pushTypes, setPushTypes] = useState([]);
  const [emailTypes, setEmailTypes] = useState([]);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/me/notifications')
      .then((r) => {
        if (cancelled) return;
        setPushPrefs(r.pushPrefs || r.prefs || {});
        setEmailPrefs(r.emailPrefs || {});
        setPushTypes(r.pushTypes || r.types || []);
        setEmailTypes(r.emailTypes || []);
      })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, []);

  const togglePush = async (type) => {
    if (!pushPrefs) return;
    const next = !pushPrefs[type];
    setPushPrefs((p) => ({ ...p, [type]: next }));
    setBusy(`push-${type}`); setErr(null);
    try {
      const r = await api.patch('/me/notifications', { pushPrefs: { [type]: next } });
      setPushPrefs(r.pushPrefs || r.prefs);
    } catch (e) {
      setPushPrefs((p) => ({ ...p, [type]: !next }));
      setErr(e.message || 'Could not update');
    } finally { setBusy(null); }
  };

  const toggleEmail = async (type) => {
    if (!emailPrefs) return;
    const next = !emailPrefs[type];
    setEmailPrefs((p) => ({ ...p, [type]: next }));
    setBusy(`email-${type}`); setErr(null);
    try {
      const r = await api.patch('/me/notifications', { emailPrefs: { [type]: next } });
      setEmailPrefs(r.emailPrefs);
    } catch (e) {
      setEmailPrefs((p) => ({ ...p, [type]: !next }));
      setErr(e.message || 'Could not update');
    } finally { setBusy(null); }
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      {err && (
        <div style={{
          padding: '6px 10px', borderRadius: 8, fontSize: 12,
          background: 'rgba(155,44,44,0.08)', color: 'var(--danger)',
          border: '1px solid rgba(155,44,44,0.25)', marginBottom: 10,
        }}>{err}</div>
      )}
      {!pushPrefs && !emailPrefs && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Loading preferences…</div>
      )}

      {pushPrefs && (
        <>
          <div className="metric-label" style={{ marginBottom: 8 }}>Push notifications</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
            {pushTypes.map((t) => {
              const meta = PUSH_LABELS[t] || { label: t, hint: '' };
              const on = pushPrefs[t] !== false;
              const busyKey = `push-${t}`;
              return (
                <label key={t} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                  padding: '10px 12px', borderRadius: 10,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  cursor: busy === busyKey ? 'wait' : 'pointer',
                }}>
                  <Switch checked={on} disabled={busy === busyKey} onChange={() => togglePush(t)}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{meta.label}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
                      {meta.hint}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </>
      )}

      {emailPrefs && emailTypes.length > 0 && (
        <>
          <div className="metric-label" style={{ marginBottom: 8 }}>Email notifications</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {emailTypes.map((t) => {
              const meta = EMAIL_LABELS[t] || { label: t, hint: '' };
              const on = emailPrefs[t] !== false;
              const busyKey = `email-${t}`;
              return (
                <label key={t} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                  padding: '10px 12px', borderRadius: 10,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  cursor: busy === busyKey ? 'wait' : 'pointer',
                }}>
                  <Switch checked={on} disabled={busy === busyKey} onChange={() => toggleEmail(t)}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{meta.label}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
                      {meta.hint}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>
            Account-critical emails (sign-up verification, password reset, payment failure, account deletion) always send.
          </div>
        </>
      )}
    </div>
  );
}

// Tiny iOS-style toggle. Inline-styled because we already have a few
// in the app and another generic component is not worth it.
function Switch({ checked, disabled, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={checked}
      onClick={onChange} disabled={disabled}
      style={{
        flexShrink: 0, marginTop: 1,
        width: 36, height: 22, borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--border-strong)',
        border: 0, padding: 2,
        cursor: disabled ? 'wait' : 'pointer',
        transition: 'background 0.15s ease',
        opacity: disabled ? 0.6 : 1,
      }}>
      <span style={{
        display: 'block',
        width: 18, height: 18, borderRadius: 999,
        background: '#fff',
        transform: checked ? 'translateX(14px)' : 'translateX(0)',
        transition: 'transform 0.15s ease',
        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }}/>
    </button>
  );
}

// Lightweight support inbox. Users post a question, the super-admin sees
// it in /admin → Support and replies. Polls every 15s when the panel is
// open so a reply lands without a manual refresh.
function SupportCard() {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const r = await api.get('/support');
      setData(r);
    } catch (e) { setErr(e.message); }
  };

  // Initial load when the panel opens. The recurring poll is wired
  // through useIntervalWhenVisible below so a backgrounded tab stops
  // hammering /support — at scale that's the difference between
  // baseline RPS being "active users" and "every stale open tab."
  useEffect(() => { if (open) load(); }, [open]);
  useIntervalWhenVisible(load, 15000, open);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true); setErr(null);
    try {
      await api.post('/support', { text: t });
      setText('');
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 22 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>Help</div>
      <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>Contact support</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Stuck on something or have feedback? Send us a message — we'll
        reply right here. You'll get a push notification when we do
        (if you've enabled them).
      </p>
      {!open ? (
        <button onClick={() => setOpen(true)} className="btn btn-outline">
          <Icons.Chat size={13} sw={1.7}/> Open support chat
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{
            background: 'var(--surface-2)', borderRadius: 10, padding: 10,
            maxHeight: 320, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            border: '1px solid var(--border)',
          }}>
            {data?.messages?.length ? data.messages.map((m) => (
              <div key={m.id} style={{
                alignSelf: m.sender === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '82%',
                padding: '8px 12px', borderRadius: 12,
                fontSize: 13.5, lineHeight: 1.5,
                background: m.sender === 'user' ? 'var(--accent)' : 'var(--surface)',
                color: m.sender === 'user' ? 'var(--accent-ink)' : 'var(--fg)',
                border: m.sender === 'user' ? 'none' : '1px solid var(--border)',
                whiteSpace: 'pre-wrap',
              }}>{m.text}</div>
            )) : (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', textAlign: 'center', padding: 16 }}>
                No messages yet. Send one below to start the conversation.
              </div>
            )}
          </div>
          {err && (
            <div style={{
              padding: '6px 10px', borderRadius: 8, fontSize: 12,
              background: 'rgba(155,44,44,0.08)', color: 'var(--danger)',
              border: '1px solid rgba(155,44,44,0.25)',
            }}>{err}</div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
              placeholder="What's on your mind?" disabled={busy}
              style={{
                flex: 1, padding: '10px 12px', borderRadius: 10,
                background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
                color: 'var(--fg)', fontSize: 13.5, outline: 'none',
              }}/>
            <button onClick={send} disabled={busy || !text.trim()}
              className="btn btn-primary" style={{ padding: '8px 14px' }}>
              <Icons.Arrow size={13} sw={2}/>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Replay walkthrough card. Resets walkthrough_completed_at server-side,
// then redirects to /dashboard?walkthrough=1 so AppShell auto-launches
// the tour from the override URL flag (no second refetch needed).
function WalkthroughCard() {
  const { ctx, refresh } = useUserContext();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);

  if (!ctx?.isOwner) return null;
  const seen = !!ctx.walkthroughCompletedAt;

  const replay = async () => {
    setBusy(true);
    try {
      await api.post('/me/walkthrough', { reset: true });
      await refresh();
      nav('/dashboard?walkthrough=1');
    } catch {
      // Best-effort — fall back to URL flag even if the reset POST hiccups.
      nav('/dashboard?walkthrough=1');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 22 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>App tour</div>
      <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>
        {seen ? 'Replay the walkthrough' : 'Take the walkthrough'}
      </h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        A 1-minute tour through every section of THRYVE. Doesn't touch any of
        your data — start it any time you'd like a refresher.
      </p>
      <button onClick={replay} disabled={busy}
        className="btn btn-outline">
        <Icons.Trending size={13} sw={1.7}/> {busy ? 'Loading…' : (seen ? 'Replay walkthrough' : 'Start walkthrough')}
      </button>
    </div>
  );
}

// Branding: logo + accent color + email signature + business name.
// Drives every client-facing email (invoices, documents, booking
// reminders, etc.) so the recipient sees the OWNER'S brand instead of
// THRYVE's defaults. Saves field-by-field — no big "Save" button.
function BrandingCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [savingField, setSavingField] = useState(null);
  const [uploading, setUploading] = useState(false);

  // Local edit buffers so we can save on blur instead of every keystroke.
  const [name, setName] = useState('');
  const [accent, setAccent] = useState('#2E3168');
  const [signature, setSignature] = useState('');

  useEffect(() => {
    let live = true;
    api.get('/account/branding')
      .then((r) => {
        if (!live) return;
        setData(r.branding);
        setName(r.branding.businessName || '');
        setAccent(r.branding.accentColor || '#2E3168');
        setSignature(r.branding.emailSignature || '');
      })
      .catch((e) => live && setErr(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const save = async (patch, key) => {
    setSavingField(key); setErr(null);
    try {
      const r = await api.patch('/account/branding', patch);
      setData(r.branding);
    } catch (e) { setErr(e); }
    finally { setSavingField(null); }
  };

  const onPickLogo = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setErr(new Error('Logo must be under 2 MB')); return; }
    setUploading(true); setErr(null);
    try {
      const { upload } = await import('@vercel/blob/client');
      const result = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/account/branding-logo-token',
        contentType: file.type,
      });
      await save({ logoUrl: result.url, logoPathname: result.pathname }, 'logo');
    } catch (ex) { setErr(ex); }
    finally { setUploading(false); }
  };
  const removeLogo = () => save({ logoUrl: null, logoPathname: null }, 'logo');

  if (loading) {
    return (
      <div className="card" style={{ padding: 22 }}>
        <div className="metric-label" style={{ marginBottom: 8 }}>Email branding</div>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 22 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>Email branding</div>
      <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>Make every email feel like yours</h3>
      <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Your logo and brand color appear on every invoice, document, and
        booking email your clients receive. Replies route to your inbox.
      </p>

      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18 }}>
        <div style={{
          width: 88, height: 88, borderRadius: 12,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', flexShrink: 0,
        }}>
          {data?.logoUrl
            ? <img src={data.logoUrl} alt="" style={{ maxWidth: '85%', maxHeight: '85%', objectFit: 'contain' }}/>
            : <Icons.Image size={28} stroke="var(--muted)"/>}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 4 }}>Logo</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10 }}>
            PNG, JPG, WebP, or SVG. Up to 2 MB. Renders at 42px tall in emails.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <label className="btn btn-outline" style={{ cursor: 'pointer', fontSize: 12 }}>
              <Icons.Paperclip size={12}/> {uploading ? 'Uploading…' : (data?.logoUrl ? 'Replace' : 'Upload')}
              <input type="file" accept="image/*" onChange={onPickLogo}
                disabled={uploading} style={{ display: 'none' }}/>
            </label>
            {data?.logoUrl && (
              <button className="btn btn-ghost" onClick={removeLogo}
                disabled={savingField === 'logo'}
                style={{ color: 'var(--danger)', fontSize: 12 }}>
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Business name */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500, display: 'block' }}>
          Business name
        </label>
        <input value={name} onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== (data?.businessName || '') && save({ businessName: name }, 'name')}
          placeholder="e.g., Calm Hands Wellness"
          style={fieldStyle}/>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          Shown in email subjects ("Invoice INV-1001 from Calm Hands Wellness") and the email header.
        </div>
      </div>

      {/* Accent color */}
      <div style={{ marginBottom: 18 }}>
        <label style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500, display: 'block' }}>
          Brand accent color
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input type="color" value={accent}
            onChange={(e) => setAccent(e.target.value)}
            onBlur={() => accent !== (data?.accentColor || '#2E3168') && save({ accentColor: accent }, 'accent')}
            style={{
              width: 48, height: 40, borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'var(--surface)', cursor: 'pointer', padding: 4,
            }}/>
          <input value={accent}
            onChange={(e) => setAccent(e.target.value)}
            onBlur={() => accent !== (data?.accentColor || '#2E3168') && save({ accentColor: accent }, 'accent')}
            placeholder="#2E3168"
            style={{ ...fieldStyle, width: 140, fontFamily: 'ui-monospace, monospace' }}/>
          <button type="button"
            onClick={() => { setAccent('#2E3168'); save({ accentColor: null }, 'accent'); }}
            className="btn btn-ghost" style={{ fontSize: 12 }}>Reset</button>
          <div style={{ flex: 1 }}/>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: '8px 16px', borderRadius: 10,
            background: accent, color: '#fff', fontSize: 12, fontWeight: 600,
          }}>Sample CTA</span>
        </div>
      </div>

      {/* Signature */}
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500, display: 'block' }}>
          Email signature (optional)
        </label>
        <textarea value={signature} onChange={(e) => setSignature(e.target.value)}
          onBlur={() => signature !== (data?.emailSignature || '') && save({ emailSignature: signature }, 'sig')}
          rows={4} maxLength={2000}
          placeholder={`— Kayla\nFounder, Calm Hands Wellness\n(415) 555-0123`}
          style={{ ...fieldStyle, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}/>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          Appended to every client-facing email under your message body. Plain text — line breaks are preserved.
        </div>
      </div>

      {savingField && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>Saving…</div>
      )}
      {err && (
        <div style={{
          marginTop: 10, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12.5,
        }}>{err.message || 'Save failed'}</div>
      )}
    </div>
  );
}

const fieldStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};
