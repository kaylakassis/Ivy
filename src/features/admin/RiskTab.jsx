// Admin → Risk: fraud protection in one place. Lists businesses that are
// on hold and businesses with a flag nobody has looked at yet, and lets
// the operator take one offline, lift a hold, or mark it as fine.
// Reads and writes /api/admin/risk (super-admin only).
//
// A hold takes the business offline for everyone (booking, website, shop
// and payment pages, and the owner's app). Nothing is deleted, and lifting
// the hold brings it all back.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import UserProfileSheet, { relTime } from './UserProfileSheet.jsx';

const REASONS = [
  'Looks like a fake business',
  'Testing stolen cards',
  'Stripe flagged this account',
  'Signed up from outside the US',
];

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

export default function RiskTab({ labels }) {
  const [accounts, setAccounts] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [checking, setChecking] = useState(false);

  const [limits, setLimits] = useState(null);

  const load = () => api.get('/admin/risk')
    .then((r) => { setAccounts(r.accounts || []); setLimits(r.limits || null); setErr(null); })
    .catch((e) => setErr(e.message || 'Could not load the risk list.'));
  useEffect(() => { load(); }, []);

  const act = async (payload) => {
    setErr(null); setNote(null);
    try {
      const r = await api.post('/admin/risk', payload);
      if (r.accounts) setAccounts(r.accounts);
      return r;
    } catch (e) {
      setErr(e.message || 'That did not work. Nothing was changed.');
      return null;
    }
  };

  const checkStripe = async () => {
    setChecking(true);
    const r = await act({ action: 'sync' });
    setChecking(false);
    if (!r) return;
    if (r.ok === false) { setNote('Stripe is not set up on this site, so there was nothing to check.'); return; }
    const parts = [`Checked ${r.checked} connected ${r.checked === 1 ? 'account' : 'accounts'} with Stripe.`];
    parts.push(r.held > 0 ? `${r.held} ${r.held === 1 ? 'was' : 'were'} rejected by Stripe and taken offline.` : 'No new rejections.');
    if (r.failed > 0) parts.push(`${r.failed} could not be checked.`);
    if (!r.complete) parts.push('There are more accounts than one check covers. Run it again to continue.');
    setNote(parts.join(' '));
  };

  const held = (accounts || []).filter((a) => a.held);
  const flagged = (accounts || []).filter((a) => !a.held);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ padding: 18, display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Risk</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.55 }}>
            Businesses that are on hold, and businesses worth a second look. Taking a business offline turns off its booking, website and payment pages and locks the owner's app. Nothing is deleted, and you can lift a hold at any time.
            When Stripe rejects an account, Ivy takes that business offline on its own and emails you.
          </div>
        </div>
        <button type="button" className="btn btn-outline" onClick={checkStripe} disabled={checking} style={{ minHeight: 40 }}>
          <Icons.Repeat size={14}/> {checking ? 'Checking with Stripe…' : 'Check Stripe now'}
        </button>
      </div>

      {limits && <LimitsCard limits={limits} onSaved={setLimits} act={act}/>}

      {err && <div role="alert" className="card" style={{ padding: 12, fontSize: 13, color: 'var(--danger)', borderColor: 'var(--danger)' }}>{err}</div>}
      {note && <div role="status" className="card" style={{ padding: 12, fontSize: 13, color: 'var(--fg-2)' }}>{note}</div>}

      {accounts === null && !err && <div style={{ fontSize: 13, color: 'var(--muted)', padding: 8 }}>Loading…</div>}

      {accounts !== null && (
        <>
          <Group title="On hold" count={held.length} empty="No business is on hold.">
            {held.map((a) => <AccountCard key={a.workspaceId} a={a} act={act} labels={labels}/>)}
          </Group>
          <Group title="Worth a second look" count={flagged.length} empty="Nothing is flagged right now.">
            {flagged.map((a) => <AccountCard key={a.workspaceId} a={a} act={act} labels={labels}/>)}
          </Group>
        </>
      )}
    </div>
  );
}

// The card payment limits for a business Stripe has not verified yet.
// Amounts are typed in dollars; the server keeps cents.
function LimitsCard({ limits, onSaved, act }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);
  const usd = (cents) => `$${(Number(cents || 0) / 100).toLocaleString('en-US')}`;
  const start = () => {
    setForm({ enabled: limits.enabled, pay: String(limits.maxPaymentCents / 100), count: String(limits.maxDailyCount), total: String(limits.maxDailyCents / 100) });
    setEditing(true);
  };
  const num = (v) => Number(String(v).replace(/[^0-9.]/g, ''));
  const valid = form && num(form.pay) >= 1 && num(form.count) >= 1 && num(form.total) >= num(form.pay);
  const save = async () => {
    setBusy(true);
    const r = await act({
      action: 'limits',
      limits: {
        enabled: form.enabled,
        maxPaymentCents: Math.round(num(form.pay) * 100),
        maxDailyCount: Math.round(num(form.count)),
        maxDailyCents: Math.round(num(form.total) * 100),
      },
    });
    setBusy(false);
    if (r?.limits) { onSaved(r.limits); setEditing(false); }
  };
  const field = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)', flex: '1 1 150px', minWidth: 0 };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Limits for new businesses</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.55 }}>
            Until Stripe has finished verifying a new business, its card payments are capped. The caps lift on their own the moment Stripe verifies the account, and never come back for that business.
          </div>
          {!editing && (
            <div style={{ fontSize: 13.5, marginTop: 10, lineHeight: 1.6 }}>
              {limits.enabled ? (
                <>
                  <strong>On.</strong> Up to <strong>{usd(limits.maxPaymentCents)}</strong> per card payment, <strong>{limits.maxDailyCount}</strong> card payments in 24 hours, and <strong>{usd(limits.maxDailyCents)}</strong> in total in 24 hours.
                </>
              ) : (
                <><strong>Off.</strong> New businesses can take card payments of any size.</>
              )}
            </div>
          )}
        </div>
        {!editing && <button type="button" className="btn btn-outline" onClick={start} style={{ minHeight: 40 }}><Icons.Edit size={13}/> Change</button>}
      </div>
      {editing && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })}/>
            Limit card payments until Stripe verifies a new business
          </label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', opacity: form.enabled ? 1 : 0.5 }}>
            <label style={field}>Largest single payment ($)
              <input className="input" inputMode="decimal" value={form.pay} disabled={!form.enabled} onChange={(e) => setForm({ ...form, pay: e.target.value })}/>
            </label>
            <label style={field}>Card payments in 24 hours
              <input className="input" inputMode="numeric" value={form.count} disabled={!form.enabled} onChange={(e) => setForm({ ...form, count: e.target.value })}/>
            </label>
            <label style={field}>Total in 24 hours ($)
              <input className="input" inputMode="decimal" value={form.total} disabled={!form.enabled} onChange={(e) => setForm({ ...form, total: e.target.value })}/>
            </label>
          </div>
          {!valid && <div style={{ fontSize: 12, color: 'var(--danger)' }}>Each number must be at least 1, and the 24 hour total cannot be less than the largest single payment.</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={busy || !valid} onClick={save} style={{ minHeight: 40, opacity: busy || !valid ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save limits'}</button>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setEditing(false)} style={{ minHeight: 40 }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

function Group({ title, count, empty, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {title} · {count}
      </div>
      {count === 0
        ? <div className="card" style={{ padding: 16, fontSize: 13, color: 'var(--muted)' }}>{empty}</div>
        : children}
    </div>
  );
}

function Chip({ children, tone = 'warn' }) {
  const c = tone === 'bad' ? 'var(--danger)' : tone === 'ok' ? 'var(--ok)' : 'var(--warn, #c98500)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999,
      fontSize: 12, fontWeight: 600, color: c, lineHeight: 1.4,
      border: `1px solid color-mix(in srgb, ${c} 45%, transparent)`,
      background: `color-mix(in srgb, ${c} 10%, transparent)`,
    }}>{children}</span>
  );
}

function AccountCard({ a, act, labels }) {
  const [mode, setMode] = useState(null); // 'hold' | 'release' | null
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const run = async (payload) => {
    setBusy(true);
    const r = await act({ workspaceId: a.workspaceId, ...payload });
    setBusy(false);
    if (r) { setMode(null); setReason(''); }
  };

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, borderColor: a.held ? 'var(--danger)' : undefined }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>{a.businessName}</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)', marginTop: 2, overflowWrap: 'anywhere' }}>
            {a.ownerName ? `${a.ownerName} · ` : ''}{a.email}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
            Signed up {fmtDate(a.createdAt)} ({relTime(a.createdAt)})
            {a.signupCountry ? ` · from ${a.signupCountry}` : ''}
            {' · '}{a.emailVerified ? 'email confirmed' : 'email not confirmed'}
            {a.stripeStatus ? ` · Stripe: ${a.stripeStatus}` : ' · no Stripe account'}
            {a.paymentsLimited ? ' · card payments limited until Stripe verifies them' : ''}
          </div>
        </div>
        {a.held && <Chip tone="bad"><Icons.Lock size={12}/> On hold</Chip>}
      </div>

      {a.held && (
        <div style={{ fontSize: 13, lineHeight: 1.5, padding: '10px 12px', borderRadius: 8, background: 'color-mix(in srgb, var(--danger) 8%, transparent)' }}>
          <strong>Offline since {fmtDate(a.holdAt)}.</strong> {a.holdReason || 'Held for review'}.{' '}
          <span style={{ color: 'var(--muted)' }}>{a.holdSource === 'stripe' ? 'Placed automatically.' : 'Placed by an admin.'}</span>
        </div>
      )}

      {a.flags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {a.flags.map((f) => <Chip key={f.id} tone={f.id === 'stripe' || f.id === 'failed_payments' || f.id === 'over_limit' ? 'bad' : 'warn'}>{f.label}</Chip>)}
        </div>
      )}

      {mode === 'hold' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Take {a.businessName} offline?</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Its booking, website and payment pages turn off and the owner's app is locked until you lift the hold. Nothing is deleted.
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {REASONS.map((r) => (
              <button key={r} type="button" onClick={() => setReason(r)} className="btn btn-outline"
                style={{ fontSize: 12, padding: '5px 10px', borderColor: reason === r ? 'var(--accent)' : undefined }}>{r}</button>
            ))}
          </div>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
            placeholder="Why? (kept on record)" aria-label="Reason for the hold"/>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={busy || !reason.trim()} onClick={() => run({ action: 'hold', reason: reason.trim() })}
              style={{ background: 'var(--danger)', color: '#fff', opacity: busy || !reason.trim() ? 0.6 : 1, minHeight: 40 }}>
              {busy ? 'Taking offline…' : 'Take offline'}
            </button>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => { setMode(null); setReason(''); }} style={{ minHeight: 40 }}>Cancel</button>
          </div>
        </div>
      )}

      {mode === 'release' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Lift the hold on {a.businessName}?</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Its pages and the owner's app come back the way they were{a.holdSource === 'stripe' ? '. Stripe has still rejected its payments account, so it cannot take card payments' : ''}.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run({ action: 'release' })} style={{ minHeight: 40 }}>
              {busy ? 'Lifting…' : 'Lift the hold'}
            </button>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => setMode(null)} style={{ minHeight: 40 }}>Cancel</button>
          </div>
        </div>
      )}

      {!mode && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {a.held ? (
            <button type="button" className="btn btn-outline" onClick={() => setMode('release')} style={{ minHeight: 40 }}>Lift the hold</button>
          ) : (
            <>
              <button type="button" className="btn btn-outline" onClick={() => setMode('hold')} style={{ minHeight: 40, color: 'var(--danger)' }}>
                <Icons.Lock size={13}/> Take offline
              </button>
              <button type="button" className="btn btn-outline" disabled={busy} onClick={() => run({ action: 'reviewed' })} style={{ minHeight: 40 }}>
                <Icons.Check size={13}/> Looks fine
              </button>
            </>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => setOpen((v) => !v)} style={{ minHeight: 40 }}>
            {open ? 'Hide details' : 'See details'}
          </button>
        </div>
      )}

      {open && a.ownerId && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <UserProfileSheet userId={a.ownerId} labels={labels}/>
        </div>
      )}
    </div>
  );
}
