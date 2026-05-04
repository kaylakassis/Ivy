// /admin — operator console for super-admins.
// Sub-tabs:
//   Overview   → analytics counters + churn (configurable date range)
//   Users      → search/filter/list every user, manage type, reset password,
//                send reset link, create new user with a chosen type
//   Affiliates → CRUD affiliate rows + per-affiliate use & revenue stats
//   Support    → reply to support threads
//
// The route lives in App.jsx; this component just renders. Visibility on
// the sidebar is filtered via NAV.superAdminOnly. The API endpoints
// behind /api/admin/* enforce real super-admin auth, so even if a
// non-admin lands here directly they'll see error states.
import React, { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';

const TABS = [
  { id: 'overview',   label: 'Overview',   icon: 'Trending' },
  { id: 'users',      label: 'Users',      icon: 'Users' },
  { id: 'affiliates', label: 'Affiliates', icon: 'Gift' },
  { id: 'support',    label: 'Support',    icon: 'Chat' },
];

export default function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');

  if (!user?.isSuperAdmin) {
    return (
      <div className="page-pad">
        <EmptyNote icon="Settings" title="Admins only"
          hint="This page is restricted to super-admin operators."/>
      </div>
    );
  }

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 30 }}>Admin</h2>
        <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
          Operator console — analytics, users, affiliates, support.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const Icon = Icons[t.icon] || Icons.Check;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`btn ${active ? 'btn-primary' : 'btn-outline'}`}
              style={{ padding: '7px 14px', fontSize: 13 }}>
              <Icon size={13} sw={1.7}/> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'overview'   && <Overview/>}
      {tab === 'users'      && <UsersTab/>}
      {tab === 'affiliates' && <AffiliatesTab/>}
      {tab === 'support'    && <SupportTab/>}
    </div>
  );
}

// ---------- Date range picker (shared across tabs that need it) ----------

const PRESETS = [
  { id: '1h',   label: 'Last hour',   ms: 60 * 60 * 1000 },
  { id: '24h',  label: 'Last 24h',    ms: 24 * 60 * 60 * 1000 },
  { id: '2d',   label: 'Last 2 days', ms: 2  * 24 * 60 * 60 * 1000 },
  { id: '7d',   label: 'Last 7 days', ms: 7  * 24 * 60 * 60 * 1000 },
  { id: '30d',  label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: '1y',   label: 'Last year',   ms: 365 * 24 * 60 * 60 * 1000 },
  { id: 'all',  label: 'All time',    ms: null },
  { id: 'custom', label: 'Custom…',   ms: null },
];

function useDateRange(defaultPreset = '30d') {
  const [presetId, setPresetId] = useState(defaultPreset);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo,   setCustomTo]   = useState('');

  const range = useMemo(() => {
    const now = new Date();
    if (presetId === 'all') {
      return { from: '1970-01-01T00:00:00Z', to: now.toISOString() };
    }
    if (presetId === 'custom') {
      const from = customFrom ? new Date(customFrom).toISOString() : '1970-01-01T00:00:00Z';
      const to   = customTo   ? new Date(customTo).toISOString()   : now.toISOString();
      return { from, to };
    }
    const p = PRESETS.find((x) => x.id === presetId);
    const from = p?.ms ? new Date(now.getTime() - p.ms).toISOString() : '1970-01-01T00:00:00Z';
    return { from, to: now.toISOString() };
  }, [presetId, customFrom, customTo]);

  return { range, presetId, setPresetId, customFrom, setCustomFrom, customTo, setCustomTo };
}

function DateRangeBar({ presetId, setPresetId, customFrom, setCustomFrom, customTo, setCustomTo }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: 10, borderRadius: 10,
      background: 'var(--surface-2)', border: '1px solid var(--border)',
    }}>
      <span style={{ fontSize: 11.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Range
      </span>
      {PRESETS.map((p) => (
        <button key={p.id} onClick={() => setPresetId(p.id)}
          className={`btn ${presetId === p.id ? 'btn-primary' : 'btn-outline'}`}
          style={{ padding: '4px 10px', fontSize: 11.5 }}>
          {p.label}
        </button>
      ))}
      {presetId === 'custom' && (
        <>
          <input type="datetime-local" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
            style={inputSty}/>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>→</span>
          <input type="datetime-local" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
            style={inputSty}/>
        </>
      )}
    </div>
  );
}

const inputSty = {
  padding: '4px 8px', borderRadius: 6, fontSize: 12,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', outline: 'none',
};

// ---------- Overview tab ----------

function Overview() {
  const dr = useDateRange('30d');
  const [data, setData] = useState(null);
  const [err, setErr]   = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null); setErr(null);
    api.get(`/admin/analytics?from=${encodeURIComponent(dr.range.from)}&to=${encodeURIComponent(dr.range.to)}`)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, [dr.range.from, dr.range.to]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <DateRangeBar {...dr}/>
      {err && <ErrCard msg={err}/>}
      {!data && !err && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
      {data && (
        <>
          <div className="grid-auto" style={{ gap: 12 }}>
            <Stat label="Total users"            value={fmtN(data.totals.users)}/>
            <Stat label="New signups (window)"   value={fmtN(data.totals.newSignups)} accent/>
            <Stat label="Business — Active"      value={fmtN(data.totals.businessActive)}/>
            <Stat label="Business — Trial"       value={fmtN(data.totals.businessTrial)}/>
            <Stat label="Sponsored"              value={fmtN(data.totals.sponsored)}/>
            <Stat label="Affiliates"             value={fmtN(data.totals.affiliate)}/>
            <Stat label="Client-only"            value={fmtN(data.totals.clientOnly)}/>
          </div>
          <div className="grid-auto" style={{ gap: 12 }}>
            <Stat label="Revenue (window)"  value={fmtMoney(data.totals.revenueWindow)}  accent/>
            <Stat label="Revenue (all time)" value={fmtMoney(data.totals.revenueAllTime)}/>
            <Stat label="Cancelled (window)" value={fmtN(data.churn.cancelledInWindow)}/>
            <Stat label="Churn rate"        value={`${data.churn.ratePct}%`}
              hint={`${data.churn.cancelledInWindow} cancelled / ${data.churn.activeAtWindowStart} active at window start`}/>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent, hint }) {
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="metric-label" style={{ marginBottom: 6 }}>{label}</div>
      <div className="metric-value" style={{
        fontSize: 28, fontWeight: 600,
        color: accent ? 'var(--accent)' : 'var(--fg)',
      }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// ---------- Users tab ----------

const USER_FILTERS = [
  { id: '',                 label: 'All' },
  { id: 'business-active',  label: 'Business · Active' },
  { id: 'business-trial',   label: 'Business · Trial' },
  { id: 'sponsored',        label: 'Sponsored' },
  { id: 'affiliate',        label: 'Affiliate' },
  { id: 'client-only',      label: 'Client-only' },
];

function UsersTab() {
  const [q, setQ]           = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage]     = useState(1);
  const [data, setData]     = useState(null);
  const [err, setErr]       = useState(null);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState(null);

  const reload = () => {
    setData(null); setErr(null);
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (filter) qs.set('type', filter);
    if (page > 1) qs.set('page', String(page));
    api.get(`/admin/users?${qs.toString()}`)
      .then((r) => setData(r))
      .catch((e) => setErr(e.message));
  };
  useEffect(reload, [filter, page]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); reload(); } }}
          placeholder="Search email or name…"
          style={{
            flex: 1, minWidth: 200, padding: '8px 12px', borderRadius: 8,
            background: 'var(--surface)', border: '1px solid var(--border-strong)',
            color: 'var(--fg)', fontSize: 13, outline: 'none',
          }}/>
        <button className="btn btn-outline" onClick={() => { setPage(1); reload(); }}>Search</button>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icons.Plus size={13} sw={2}/> New user
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {USER_FILTERS.map((f) => (
          <button key={f.id || 'all'} onClick={() => { setFilter(f.id); setPage(1); }}
            className={`btn ${filter === f.id ? 'btn-primary' : 'btn-outline'}`}
            style={{ padding: '4px 10px', fontSize: 11.5 }}>
            {f.label}
          </button>
        ))}
      </div>

      {err && <ErrCard msg={err}/>}
      {!data && !err && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
      {data && (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {data.total.toLocaleString()} total · page {data.page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: 'var(--surface-2)' }}>
                <tr style={{ textAlign: 'left' }}>
                  <Th>Email</Th><Th>Name</Th><Th>Type</Th><Th>Joined</Th><Th>Verified</Th><Th></Th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <Td>{u.email}</Td>
                    <Td>{u.name || <span style={{ color: 'var(--muted)' }}>—</span>}</Td>
                    <Td><Pill text={u.classification}/></Td>
                    <Td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</Td>
                    <Td>{u.emailVerifiedAt ? '✓' : <span style={{ color: 'var(--muted)' }}>—</span>}</Td>
                    <Td>
                      <button onClick={() => setActive(u)} className="btn btn-ghost"
                        style={{ padding: '4px 10px', fontSize: 12 }}>
                        Manage
                      </button>
                    </Td>
                  </tr>
                ))}
                {data.users.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 28 }}>
                    <EmptyNote icon="Users" title="No users match" hint="Try a different filter or search."/>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
              className="btn btn-outline">Prev</button>
            <button onClick={() => setPage((p) => p + 1)}
              disabled={(data.users.length || 0) < data.pageSize}
              className="btn btn-outline">Next</button>
          </div>
        </>
      )}

      {creating && <CreateUserModal onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); reload(); }}/>}
      {active   && <UserDetailModal user={active} onClose={() => setActive(null)}
        onChanged={() => { reload(); setActive(null); }}/>}
    </div>
  );
}

function CreateUserModal({ onClose, onCreated }) {
  const [email, setEmail] = useState('');
  const [name, setName]   = useState('');
  const [userType, setUserType] = useState('business-active');
  const [code, setCode] = useState('');
  const [sendInvite, setSendInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const body = { email: email.trim().toLowerCase(), name: name.trim() || null, userType, sendInvite };
      if (userType === 'affiliate' && code.trim()) body.code = code.trim();
      await api.post('/admin/users', body);
      onCreated();
    } catch (e2) {
      setErr(e2.message || 'Could not create user');
      setBusy(false);
    }
  };

  return (
    <Modal title="New user" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={fieldSty}/>
        </Field>
        <Field label="Name (optional)">
          <input value={name} onChange={(e) => setName(e.target.value)} style={fieldSty}/>
        </Field>
        <Field label="Type">
          <select value={userType} onChange={(e) => setUserType(e.target.value)} style={fieldSty}>
            <option value="business-active">Business — Active (paying)</option>
            <option value="business-trial">Business — Trial (28-day)</option>
            <option value="sponsored">Sponsored (comp full access)</option>
            <option value="affiliate">Affiliate (with referral code)</option>
            <option value="regular">Regular (no workspace)</option>
          </select>
        </Field>
        {userType === 'affiliate' && (
          <Field label="Affiliate code (optional)" hint="Leave blank to auto-generate.">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. KAYLA10"
              style={fieldSty}/>
          </Field>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
          <input type="checkbox" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)}/>
          Send a welcome email with password-set link
        </label>
        {err && <ErrCard msg={err}/>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} className="btn btn-outline">Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UserDetailModal({ user, onClose, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(null);

  const action = async (label, fn) => {
    setBusy(label); setErr(null); setInfo(null);
    try { await fn(); setInfo(`${label} ✓`); }
    catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const setType = (t) => action(`Set type → ${t}`, () => api.patch(`/admin/users/${user.id}`, { userType: t }));

  return (
    <Modal title={user.email} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        <Row k="Name" v={user.name || '—'}/>
        <Row k="Joined" v={user.createdAt ? new Date(user.createdAt).toLocaleString() : '—'}/>
        <Row k="Email verified" v={user.emailVerifiedAt ? new Date(user.emailVerifiedAt).toLocaleString() : 'No'}/>
        <Row k="Classification" v={<Pill text={user.classification}/>}/>
        {user.workspace && (
          <>
            <Row k="Subscription" v={user.workspace.status}/>
            {user.workspace.trialEndsAt && (
              <Row k="Trial ends" v={new Date(user.workspace.trialEndsAt).toLocaleString()}/>
            )}
          </>
        )}
        {user.affiliateCode && <Row k="Affiliate code" v={<code>{user.affiliateCode}</code>}/>}

        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '6px 0' }}/>

        <div className="metric-label" style={{ marginBottom: 4 }}>Change type</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['regular', 'sponsored', 'affiliate'].map((t) => (
            <button key={t} disabled={!!busy} onClick={() => setType(t)}
              className={`btn ${user.userType === t ? 'btn-primary' : 'btn-outline'}`}
              style={{ padding: '5px 12px', fontSize: 12 }}>
              {busy === `Set type → ${t}` ? '…' : t}
            </button>
          ))}
        </div>

        <div className="metric-label" style={{ marginTop: 8 }}>Actions</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button disabled={!!busy} className="btn btn-outline" style={{ padding: '5px 12px', fontSize: 12 }}
            onClick={() => action('Reset link sent', () => api.patch(`/admin/users/${user.id}`, { sendResetLink: true }))}>
            Send password-reset link
          </button>
          <button disabled={!!busy} className="btn btn-outline" style={{ padding: '5px 12px', fontSize: 12, color: 'var(--danger)', borderColor: 'var(--danger)' }}
            onClick={async () => {
              const pw = prompt('New password (min 8 chars):'); if (!pw) return;
              await action('Password set', () => api.patch(`/admin/users/${user.id}`, { password: pw }));
            }}>
            Set password manually
          </button>
        </div>

        {info && <div style={{ fontSize: 12, color: 'var(--ok)' }}>{info}</div>}
        {err && <ErrCard msg={err}/>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
          <button onClick={onClose} className="btn btn-outline">Close</button>
          <button onClick={onChanged} className="btn btn-primary">Refresh list</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Affiliates tab ----------

function AffiliatesTab() {
  const dr = useDateRange('30d');
  const [data, setData]   = useState(null);
  const [err, setErr]     = useState(null);
  const [editing, setEditing] = useState(null);

  const reload = () => {
    setData(null); setErr(null);
    api.get(`/admin/affiliates?from=${encodeURIComponent(dr.range.from)}&to=${encodeURIComponent(dr.range.to)}`)
      .then(setData).catch((e) => setErr(e.message));
  };
  useEffect(reload, [dr.range.from, dr.range.to]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <DateRangeBar {...dr}/>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        Create affiliates from the Users tab (set type → Affiliate).
        This view shows every affiliate's per-window stats.
      </div>
      {err && <ErrCard msg={err}/>}
      {!data && !err && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
      {data && data.affiliates.length === 0 && (
        <div className="card" style={{ padding: 28 }}>
          <EmptyNote icon="Gift" title="No affiliates yet"
            hint="Go to the Users tab → New user → Type: Affiliate."/>
        </div>
      )}
      {data && data.affiliates.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr style={{ textAlign: 'left' }}>
                <Th>Code</Th><Th>User</Th>
                <Th>24h</Th><Th>7d</Th><Th>30d</Th><Th>Total</Th>
                <Th>Rev (window)</Th><Th>Rev (all time)</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {data.affiliates.map((a) => (
                <tr key={a.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <Td>
                    <code style={{
                      background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 6,
                    }}>{a.code}</code>
                    {!a.active && <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--muted)' }}>INACTIVE</span>}
                  </Td>
                  <Td>{a.user?.email}</Td>
                  <Td>{a.uses.last24h}</Td>
                  <Td>{a.uses.last7d}</Td>
                  <Td>{a.uses.last30d}</Td>
                  <Td>{a.uses.total}</Td>
                  <Td>{fmtMoney((a.revenue.windowCents || 0) / 100)}</Td>
                  <Td>{fmtMoney((a.revenue.totalCents || 0) / 100)}</Td>
                  <Td>
                    <button onClick={() => setEditing(a)} className="btn btn-ghost"
                      style={{ padding: '4px 10px', fontSize: 12 }}>Edit</button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EditAffiliateModal a={editing}
          onClose={() => setEditing(null)}
          onChanged={() => { setEditing(null); reload(); }}/>
      )}
    </div>
  );
}

function EditAffiliateModal({ a, onClose, onChanged }) {
  const [code, setCode]       = useState(a.code);
  const [active, setActive]   = useState(a.active);
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.patch(`/admin/affiliates/${a.id}`, { code: code.toUpperCase(), active });
      onChanged();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const remove = async () => {
    if (!confirm(`Delete affiliate ${a.code}? Past attribution rows will also be removed.`)) return;
    setBusy(true); setErr(null);
    try { await api.del(`/admin/affiliates/${a.id}`); onChanged(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <Modal title={`Edit ${a.code}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
        <Field label="Code" hint="3–40 chars; A–Z, 0–9, _ or -.">
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={fieldSty}/>
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}/>
          Active (uncheck to stop accepting new signups via this code)
        </label>
        {err && <ErrCard msg={err}/>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between' }}>
          <button onClick={remove} disabled={busy} className="btn btn-outline"
            style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>Delete</button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} className="btn btn-outline">Cancel</button>
            <button onClick={save} disabled={busy} className="btn btn-primary">Save</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Support tab ----------

function SupportTab() {
  const [threads, setThreads] = useState(null);
  const [active,  setActive]  = useState(null);
  const [err, setErr]         = useState(null);

  const reload = async () => {
    try {
      const r = await api.get('/admin/support');
      setThreads(r.threads);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { reload(); }, []);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 12, minHeight: 420 }}>
      <div className="card" style={{ padding: 0, overflow: 'auto', maxHeight: 600 }}>
        {err && <div style={{ padding: 12 }}><ErrCard msg={err}/></div>}
        {!threads && !err && <div style={{ padding: 12, fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
        {threads && threads.length === 0 && <div style={{ padding: 18 }}>
          <EmptyNote icon="Chat" title="Inbox is empty" hint="When a user sends a support message, it'll show here."/>
        </div>}
        {threads && threads.map((t) => (
          <button key={t.id} onClick={() => setActive(t)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: 12, borderTop: '1px solid var(--border)',
              background: active?.id === t.id ? 'var(--surface-2)' : 'transparent',
              cursor: 'pointer',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{t.user.email}</span>
              {t.unreadAdmin > 0 && (
                <span style={{
                  fontSize: 10, padding: '0 6px', borderRadius: 99,
                  background: 'var(--accent)', color: 'var(--accent-ink)',
                }}>{t.unreadAdmin}</span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--muted)' }}>
                {t.status}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
              {t.lastPreview || '—'}
            </div>
          </button>
        ))}
      </div>
      <div>
        {active ? <SupportConversation thread={active} onChanged={reload}/>
                : <div className="card" style={{ padding: 28 }}>
                    <EmptyNote icon="Chat" title="Pick a conversation" hint="Click a row on the left."/>
                  </div>}
      </div>
    </div>
  );
}

function SupportConversation({ thread, onChanged }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await api.get(`/admin/support?threadId=${thread.id}`);
    setData(r);
  };
  useEffect(() => { load(); }, [thread.id]);

  const send = async () => {
    const t = text.trim(); if (!t) return;
    setBusy(true);
    try {
      await api.post('/admin/support', { threadId: thread.id, text: t });
      setText('');
      await load();
      onChanged?.();
    } finally { setBusy(false); }
  };
  const toggleStatus = async () => {
    await api.patch('/admin/support', {
      threadId: thread.id,
      status: data?.thread.status === 'open' ? 'closed' : 'open',
    });
    await load();
    onChanged?.();
  };

  return (
    <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 420 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{data?.thread.user.email}</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Status: {data?.thread.status}</div>
        </div>
        <button onClick={toggleStatus} className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 12 }}>
          {data?.thread.status === 'open' ? 'Close' : 'Re-open'}
        </button>
      </div>
      <div style={{
        flex: 1, overflow: 'auto', background: 'var(--surface-2)',
        borderRadius: 10, padding: 10,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {data?.messages.map((m) => (
          <div key={m.id} style={{
            alignSelf: m.sender === 'admin' ? 'flex-end' : 'flex-start',
            maxWidth: '80%',
            padding: '8px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.45,
            background: m.sender === 'admin' ? 'var(--accent)' : 'var(--surface)',
            color: m.sender === 'admin' ? 'var(--accent-ink)' : 'var(--fg)',
            border: m.sender === 'admin' ? 'none' : '1px solid var(--border)',
            whiteSpace: 'pre-wrap',
          }}>{m.text}</div>
        ))}
        {(!data || data.messages.length === 0) && (
          <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: 20 }}>
            No messages yet.
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
          placeholder="Type your reply…" disabled={busy}
          style={{ flex: 1, padding: '10px 12px', borderRadius: 10,
            background: 'var(--surface-2)', border: '1px solid var(--border-strong)',
            color: 'var(--fg)', fontSize: 13.5, outline: 'none' }}/>
        <button onClick={send} disabled={busy || !text.trim()} className="btn btn-primary"
          style={{ padding: '8px 14px' }}>Send</button>
      </div>
    </div>
  );
}

// ---------- Tiny shared bits ----------

function Modal({ title, onClose, children }) {
  return (
    <div role="dialog" onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} className="card"
        style={{ width: '100%', maxWidth: 520, padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{title}</h3>
          <button onClick={onClose} className="btn btn-ghost" style={{ padding: 6 }}>
            <Icons.X size={14}/>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ErrCard({ msg }) {
  return (
    <div style={{
      padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
      background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
      color: 'var(--danger)',
    }}>{msg}</div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
const fieldSty = {
  width: '100%', padding: '8px 12px', borderRadius: 8,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 13, outline: 'none',
};

function Th({ children }) {
  return <th style={{ padding: '10px 12px', fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{children}</th>;
}
function Td({ children }) {
  return <td style={{ padding: '10px 12px', verticalAlign: 'top' }}>{children}</td>;
}
function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' }}>
      <span style={{ color: 'var(--muted)', fontSize: 12 }}>{k}</span>
      <span style={{ fontSize: 13, textAlign: 'right' }}>{v}</span>
    </div>
  );
}
function Pill({ text }) {
  const tone = (() => {
    if (text === 'Sponsored') return 'var(--accent)';
    if (text === 'Affiliate') return 'var(--accent)';
    if (text === 'Business-Active') return 'var(--ok)';
    if (text === 'Business-Trial') return 'var(--warn)';
    if (text === 'Client-only') return 'var(--muted)';
    return 'var(--muted)';
  })();
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
      padding: '2px 8px', borderRadius: 99,
      background: `color-mix(in srgb, ${tone} 14%, transparent)`,
      color: tone,
    }}>{text}</span>
  );
}

function fmtN(n) { return Number(n || 0).toLocaleString(); }
function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
