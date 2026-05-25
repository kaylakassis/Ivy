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
  { id: 'appeals',    label: 'Review appeals', icon: 'Star' },
  { id: 'blast',      label: 'Email blast', icon: 'Spark' },
  { id: 'audit',      label: 'Audit log',  icon: 'Clock' },
  { id: 'export',     label: 'Export',     icon: 'Doc' },
  { id: 'settings',   label: 'Settings',   icon: 'Settings' },
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

      <div className="tab-row" style={{ display: 'flex', gap: 6 }}>
        {TABS.map((t) => {
          const Icon = Icons[t.icon] || Icons.Check;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`btn ${active ? 'btn-primary' : 'btn-outline'}`}
              style={{ padding: '7px 14px', fontSize: 13, whiteSpace: 'nowrap' }}>
              <Icon size={13} sw={1.7}/> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'overview'   && <Overview/>}
      {tab === 'users'      && <UsersTab/>}
      {tab === 'affiliates' && <AffiliatesTab/>}
      {tab === 'support'    && <SupportTab/>}
      {tab === 'appeals'    && <AppealsTab/>}
      {tab === 'blast'      && <BlastTab/>}
      {tab === 'audit'      && <AuditTab/>}
      {tab === 'export'     && <ExportTab/>}
      {tab === 'settings'   && <SettingsTab/>}
    </div>
  );
}

// ---------- Review appeals tab ----------
// Business owners can't hide reviews; they appeal, and the appeal lands here
// for the support team to approve (remove the review) or deny (keep it).
function AppealsTab() {
  const [appeals, setAppeals] = useState(null);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () => api.get('/admin/review-appeals')
    .then((r) => { setAppeals(r.appeals || []); setErr(null); })
    .catch(setErr);
  useEffect(() => { load(); }, []);

  const resolve = async (reviewId, action) => {
    setBusyId(reviewId);
    try { await api.post('/admin/review-appeals', { reviewId, action }); await load(); }
    catch (e) { setErr(e); }
    finally { setBusyId(null); }
  };

  if (!appeals) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {err && <div className="card" style={{ padding: 12, color: 'var(--danger)', fontSize: 13 }}>{err.message}</div>}
      {appeals.length === 0 ? (
        <EmptyNote icon="Star" title="No open appeals"
          hint="When a business owner appeals a review, it shows up here to approve (remove) or deny (keep)."/>
      ) : appeals.map((a) => (
        <div key={a.id} className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>{a.businessName}</span>
            <span style={{ color: '#E0B645', letterSpacing: 1 }}>{'★'.repeat(Math.max(0, Math.min(5, a.rating)))}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>by {a.reviewerName}</span>
          </div>
          {a.text && <div style={{ fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>“{a.text}”</div>}
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)', borderLeft: '2px solid var(--accent)', paddingLeft: 10 }}>
            <span style={{ fontWeight: 600 }}>Appeal reason:</span> {a.appealReason}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={busyId === a.id} onClick={() => resolve(a.id, 'approve')} style={{ fontSize: 12.5 }}>Approve (remove review)</button>
            <button className="btn btn-ghost" disabled={busyId === a.id} onClick={() => resolve(a.id, 'deny')} style={{ fontSize: 12.5 }}>Deny (keep review)</button>
          </div>
        </div>
      ))}
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
    // Safe ISO conversion — `new Date(invalidString).toISOString()` throws
    // RangeError. Fall back to the epoch if parsing fails, so a typo in
    // the date picker doesn't crash the admin dashboard.
    const safeIso = (raw, fallback) => {
      if (!raw) return fallback;
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
    };
    if (presetId === 'all') {
      return { from: '1970-01-01T00:00:00Z', to: now.toISOString() };
    }
    if (presetId === 'custom') {
      const from = safeIso(customFrom, '1970-01-01T00:00:00Z');
      const to   = safeIso(customTo,   now.toISOString());
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
      <EmailHealthBanner/>
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
          <SystemCard/>
        </>
      )}
    </div>
  );
}

// One-click migration trigger. Re-running the schema is idempotent —
// every statement uses IF NOT EXISTS / IF EXISTS — so this is safe to
// click after any deploy that adds columns or tweaks constraints.
// Lives at the bottom of the Overview tab so it's discoverable without
// owning a whole tab. Shows last-run state inline so you can tell
// whether anyone has applied the latest schema yet.
function SystemCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const run = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await api.post('/admin/migrate');
      setResult(r);
    } catch (e) {
      setErr(e.message || 'Migration failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Database schema</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            Re-applies every CREATE / ALTER in the schema file. Safe to click — every
            statement is idempotent. Run after any deploy that adds a new column.
          </div>
        </div>
        <button className="btn btn-outline" onClick={run} disabled={busy}
          style={{ flexShrink: 0 }}>
          {busy ? 'Running…' : 'Run migrations'}
        </button>
      </div>
      {result && (
        <div style={{
          marginTop: 12, padding: '8px 12px', borderRadius: 8,
          background: 'color-mix(in srgb, var(--ok) 8%, var(--surface-2))',
          border: '1px solid var(--ok)', color: 'var(--ok)', fontSize: 12,
        }}>
          ✓ Applied {result.applied} statements.
        </div>
      )}
      {err && (
        <div style={{
          marginTop: 12, padding: '8px 12px', borderRadius: 8,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 12,
        }}>
          {err}
        </div>
      )}
    </div>
  );
}

// Email-delivery health banner. Hidden when everything's healthy. Loud
// when EMAIL_FROM is the Resend sandbox or the configured sending
// domain isn't verified — those states mean welcome / verification /
// reset / invoice emails will silently fail to deliver to real users.
function EmailHealthBanner() {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let cancelled = false;
    api.get('/admin/email-status')
      .then((r) => { if (!cancelled) setState({ loading: false, data: r }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, err: e.message }); });
    return () => { cancelled = true; };
  }, []);

  if (state.loading || state.err) return null;
  const { from, domains = [] } = state.data || {};
  const onSandbox = !from || /resend\.dev/i.test(from);
  const verified = domains.find((d) => d.status === 'verified');
  if (!onSandbox && verified) return null;

  // Pull the From-domain so the link to Resend's dashboard is unambiguous.
  const fromDomain = (() => {
    const m = (from || '').match(/<([^>]+)>/);
    return ((m ? m[1] : from) || '').split('@').pop() || '';
  })();

  return (
    <div role="alert" style={{
      padding: 14, borderRadius: 12,
      background: 'rgba(155,44,44,0.08)',
      border: '1px solid var(--danger)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icons.Settings size={14} sw={2} stroke="var(--danger)"/>
        <strong style={{ color: 'var(--danger)', fontSize: 13 }}>
          Email delivery is broken
        </strong>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        {onSandbox ? (
          <>
            <code>EMAIL_FROM</code> is on Resend's sandbox
            (<code>{from || 'onboarding@resend.dev'}</code>).
            That address only delivers to your own verified Resend-account email,
            so welcome, verification, reset, and invoice emails are silently
            failing for everyone else.
          </>
        ) : (
          <>
            The sending domain <code>{fromDomain}</code> isn't verified in
            Resend yet, so emails will be rejected at send time.
          </>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.6 }}>
        <strong>To fix:</strong>
        <ol style={{ margin: '4px 0 0 18px', padding: 0 }}>
          <li>
            Add a domain at{' '}
            <a href="https://resend.com/domains" target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent)', fontWeight: 600 }}>
              resend.com/domains
            </a>{' '}
            and copy the SPF / DKIM / DMARC records into your DNS provider.
          </li>
          <li>Wait for Resend to mark the domain <strong>verified</strong> (usually &lt;30 min).</li>
          <li>
            Set <code>EMAIL_FROM='THRYVE &lt;noreply@your-domain.com&gt;'</code> in
            Vercel project settings (and optionally <code>EMAIL_REPLY_TO</code>).
          </li>
          <li>Redeploy. This banner disappears when everything checks out.</li>
        </ol>
      </div>
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
          <div className="card" style={{ padding: 0, overflow: 'auto' }}>
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

// Roles surfaced in the modal — five buttons that fully reconcile
// users.user_type AND workspace subscription state on the server side.
// Order goes from "no perks" → "all perks" so the row reads left-to-right.
const ROLES = [
  { id: 'regular',         label: 'Regular',          desc: 'Default. Honors normal billing.' },
  { id: 'business-trial',  label: 'Business · Trial', desc: '28-day full-access trial.' },
  { id: 'business-active', label: 'Business · Active', desc: 'Manually flag as paying.' },
  { id: 'sponsored',       label: 'Sponsored',        desc: 'Comp full access, no sub.' },
  { id: 'affiliate',       label: 'Affiliate',        desc: 'Auto-creates a referral code.' },
];

// Map a user's current state onto a single ROLES.id so the active button
// gets the primary highlight. Subscription state takes precedence over
// user_type when classifying — a sponsored user shows "Sponsored" even
// if their workspace also happens to be 'active'.
function currentRole(user) {
  if (user.userType === 'sponsored') return 'sponsored';
  if (user.userType === 'affiliate') return 'affiliate';
  const ws = user.workspace;
  if (ws?.status === 'active')   return 'business-active';
  if (ws?.status === 'trialing'
    && ws.trialEndsAt && new Date(ws.trialEndsAt) > new Date()) return 'business-trial';
  return 'regular';
}

function UserDetailModal({ user, onClose, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // `keepOpen` skips the onChanged callback so the modal stays open and
  // the success message is visible. Use for fire-and-forget actions
  // that don't change anything visible in the modal (e.g. resending an
  // email, where the row in the list doesn't need to reload either).
  const action = async (label, fn, { keepOpen = false } = {}) => {
    setBusy(label); setErr(null); setInfo(null);
    try {
      const result = await fn();
      setInfo(`${label} ✓`);
      if (!keepOpen) onChanged?.();
      return result;
    }
    catch (e) { setErr(e.message); return null; }
    finally { setBusy(null); }
  };

  const setRole = (r) => action(
    `Set role → ${r}`,
    () => api.patch(`/admin/users/${user.id}`, { role: r }),
  );

  const doDelete = async () => {
    setBusy('Deleting'); setErr(null); setInfo(null);
    try {
      await api.del(`/admin/users/${user.id}`);
      onChanged?.();   // closes modal + refreshes list
    } catch (e) { setErr(e.message); setBusy(null); setConfirmDelete(false); }
  };

  const active = currentRole(user);

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

        <div className="metric-label" style={{ marginBottom: 4 }}>Role</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {ROLES.map((r) => (
            <button key={r.id} disabled={!!busy} onClick={() => setRole(r.id)}
              title={r.desc}
              className={`btn ${active === r.id ? 'btn-primary' : 'btn-outline'}`}
              style={{ padding: '5px 12px', fontSize: 12 }}>
              {busy === `Set role → ${r.id}` ? '…' : r.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: -4 }}>
          {ROLES.find((r) => r.id === active)?.desc}
        </div>

        <div className="metric-label" style={{ marginTop: 8 }}>Actions</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button disabled={!!busy} className="btn btn-outline" style={{ padding: '5px 12px', fontSize: 12 }}
            onClick={() => action('Reset link sent',
              () => api.patch(`/admin/users/${user.id}`, { sendResetLink: true }),
              { keepOpen: true })}>
            {busy === 'Reset link sent' ? '…' : 'Send password-reset link'}
          </button>
          <button disabled={!!busy || !!user.emailVerifiedAt} className="btn btn-outline" style={{ padding: '5px 12px', fontSize: 12 }}
            title={user.emailVerifiedAt ? 'Already verified — no need to resend.' : 'Send a fresh email-verification link.'}
            onClick={async () => {
              const r = await action('Verification link sent',
                () => api.patch(`/admin/users/${user.id}`, { sendVerificationLink: true }),
                { keepOpen: true });
              if (r?.alreadyVerified) setInfo('Already verified — no email sent.');
            }}>
            {busy === 'Verification link sent' ? '…' : 'Send verification email'}
          </button>
          <button disabled={!!busy} className="btn btn-outline" style={{ padding: '5px 12px', fontSize: 12 }}
            onClick={async () => {
              const pw = prompt('New password (min 8 chars):'); if (!pw) return;
              await action('Password set', () => api.patch(`/admin/users/${user.id}`, { password: pw }));
            }}>
            {busy === 'Password set' ? '…' : 'Set password manually'}
          </button>
          <button disabled={!!busy} className="btn btn-outline" style={{ padding: '5px 12px', fontSize: 12 }}
            onClick={async () => {
              if (!confirm(`Sign in as ${user.email}? You'll see the app exactly as they do, with a banner up top to stop.`)) return;
              setBusy('Impersonating'); setErr(null);
              try {
                await api.post('/admin/impersonate', { userId: user.id });
                window.location.href = '/dashboard';
              } catch (e) { setErr(e.message); setBusy(null); }
            }}>
            View as user →
          </button>
          <button disabled={!!busy} className="btn btn-outline" style={{ padding: '5px 12px', fontSize: 12 }}
            title="Re-send the welcome email this user got at signup."
            onClick={() => action('Welcome email sent',
              () => api.patch(`/admin/users/${user.id}`, { resendWelcome: true }),
              { keepOpen: true })}>
            {busy === 'Welcome email sent' ? '…' : 'Resend welcome email'}
          </button>
        </div>

        <div className="metric-label" style={{ marginTop: 8, color: 'var(--danger)' }}>Danger zone</div>
        <button disabled={!!busy} className="btn btn-outline"
          onClick={() => setConfirmDelete(true)}
          style={{
            padding: '7px 12px', fontSize: 12,
            color: 'var(--danger)', borderColor: 'var(--danger)',
            alignSelf: 'flex-start',
          }}>
          <Icons.Trash size={12}/> Delete this user permanently
        </button>

        {info && <div style={{ fontSize: 12, color: 'var(--ok)' }}>{info}</div>}
        {err && <ErrCard msg={err}/>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
          <button onClick={onClose} className="btn btn-outline">Close</button>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDeleteUser email={user.email}
          busy={busy === 'Deleting'}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={doDelete}/>
      )}
    </Modal>
  );
}

// Email-typing confirm prevents the "I clicked it by accident" mistake.
// Cascades through the FK chain server-side, so this really wipes the
// account and everything tied to it.
function ConfirmDeleteUser({ email, busy, onCancel, onConfirm }) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  return (
    <div role="dialog" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 220,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}>
      <div className="card" onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 460, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: 'rgba(155,44,44,0.12)', color: 'var(--danger)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Trash size={16}/></div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>Delete this user?</h3>
        </div>
        <p style={{ margin: '4px 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Permanently removes <strong>{email}</strong> and everything tied to
          their account — workspace, clients, invoices, documents, messages,
          Ivy chats, support thread, push subscriptions. There is no undo.
        </p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14, fontSize: 12 }}>
          <span style={{ color: 'var(--fg-2)', fontWeight: 550 }}>
            Type <code>{email}</code> to confirm:
          </span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)}
            autoFocus autoComplete="off" placeholder={email}
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: '1px solid ' + (typed && !matches ? 'var(--danger)' : 'var(--border-strong)'),
              background: 'var(--surface)', outline: 'none',
              fontSize: 14, color: 'var(--fg)',
            }}/>
        </label>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} className="btn btn-outline">Cancel</button>
          <button onClick={onConfirm} disabled={!matches || busy}
            className="btn btn-primary"
            style={{
              background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff',
              opacity: (!matches || busy) ? 0.6 : 1,
            }}>
            {busy ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </div>
    </div>
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
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
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
    <div className="support-grid" style={{ minHeight: 420 }}>
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

// ---------- Email blast tab ----------

const BLAST_SEGMENTS = [
  { id: 'business-active', label: 'Business — Active' },
  { id: 'business-trial',  label: 'Business — Trial' },
  { id: 'sponsored',       label: 'Sponsored' },
  { id: 'affiliate',       label: 'Affiliates' },
  { id: 'client-only',     label: 'Client-only' },
  { id: 'all',             label: 'Everyone' },
];

function BlastTab() {
  const [segment, setSegment] = useState('business-active');
  const [subject, setSubject] = useState('');
  const [heading, setHeading] = useState('');
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  const dryRun = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await api.post('/admin/email-blast', { segment, subject, html, heading, dryRun: true });
      setResult(`Dry run: would send to ${r.recipients} recipient${r.recipients === 1 ? '' : 's'}.`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!confirm(`Send to every "${BLAST_SEGMENTS.find((s) => s.id === segment)?.label}" recipient?`)) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await api.post('/admin/email-blast', { segment, subject, html, heading });
      setResult(`Sent ${r.sent} of ${r.recipients} (${r.failed} failed).`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Sends a one-off email to a filtered segment of your users. Only
        verified addresses receive it (unverified ones bounce and hurt
        deliverability). The body supports HTML — keep it simple, the
        branded shell wraps it for you.
      </div>

      <Field label="Segment">
        <select value={segment} onChange={(e) => setSegment(e.target.value)} style={fieldSty}>
          {BLAST_SEGMENTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </Field>
      <Field label="Subject" hint="What lands in their inbox preview.">
        <input value={subject} onChange={(e) => setSubject(e.target.value)} style={fieldSty}/>
      </Field>
      <Field label="Heading (shown big at the top of the email)">
        <input value={heading} onChange={(e) => setHeading(e.target.value)} style={fieldSty}
          placeholder="Defaults to the subject if left blank."/>
      </Field>
      <Field label="Body (HTML)" hint="Use <p>, <ul>, <strong>. The shell adds branding + footer.">
        <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={10}
          style={{ ...fieldSty, fontFamily: 'monospace', fontSize: 12.5 }}/>
      </Field>

      {result && <div style={{ fontSize: 12.5, color: 'var(--ok)' }}>{result}</div>}
      {err && <ErrCard msg={err}/>}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button disabled={busy || !segment} onClick={dryRun} className="btn btn-outline">
          {busy ? 'Counting…' : 'Dry run · count recipients'}
        </button>
        <button disabled={busy || !subject || !html} onClick={send} className="btn btn-primary">
          {busy ? 'Sending…' : 'Send blast'}
        </button>
      </div>
    </div>
  );
}

// ---------- Audit log tab ----------

function AuditTab() {
  const [data, setData]   = useState(null);
  const [page, setPage]   = useState(1);
  const [actor, setActor] = useState('');
  const [target, setTarget] = useState('');
  const [action, setAction] = useState('');
  const [err, setErr]     = useState(null);

  const reload = () => {
    setData(null); setErr(null);
    const qs = new URLSearchParams();
    if (actor)  qs.set('actor', actor);
    if (target) qs.set('target', target);
    if (action) qs.set('action', action);
    if (page > 1) qs.set('page', String(page));
    api.get(`/admin/audit?${qs.toString()}`)
      .then(setData).catch((e) => setErr(e.message));
  };
  useEffect(reload, [page]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Actor email…"
          style={{ ...fieldSty, flex: '1 1 200px' }}/>
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target email…"
          style={{ ...fieldSty, flex: '1 1 200px' }}/>
        <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action (e.g. user.set_type)"
          style={{ ...fieldSty, flex: '1 1 200px' }}/>
        <button onClick={() => { setPage(1); reload(); }} className="btn btn-outline">Search</button>
      </div>

      {err && <ErrCard msg={err}/>}
      {!data && !err && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
      {data && (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {data.total.toLocaleString()} total events · page {data.page}
          </div>
          <div className="card" style={{ padding: 0, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead style={{ background: 'var(--surface-2)' }}>
                <tr style={{ textAlign: 'left' }}>
                  <Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Target</Th><Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={e.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <Td>{new Date(e.createdAt).toLocaleString()}</Td>
                    <Td>{e.actorEmail || <span style={{ color: 'var(--muted)' }}>system</span>}</Td>
                    <Td><code>{e.action}</code></Td>
                    <Td>{e.targetEmail || <span style={{ color: 'var(--muted)' }}>—</span>}</Td>
                    <Td><code style={{ fontSize: 11 }}>{JSON.stringify(e.meta)}</code></Td>
                  </tr>
                ))}
                {data.events.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: 28 }}>
                    <EmptyNote icon="Clock" title="No matching events" hint="Try clearing filters."/>
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
              className="btn btn-outline">Prev</button>
            <button onClick={() => setPage((p) => p + 1)}
              disabled={(data.events.length || 0) < data.pageSize}
              className="btn btn-outline">Next</button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Export tab ----------

function ExportTab() {
  const get = (kind) => {
    // Direct download — let the browser handle the CSV save dialog.
    window.location.href = `/api/admin/export?kind=${encodeURIComponent(kind)}`;
  };
  return (
    <div className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        One-click CSV exports for offline analysis or sending to your accountant.
        Includes everything you'd see in the Users / Affiliates tabs.
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-outline" onClick={() => get('users')}>
          <Icons.Users size={13}/> Download users CSV
        </button>
        <button className="btn btn-outline" onClick={() => get('affiliates')}>
          <Icons.Gift size={13}/> Download affiliates CSV
        </button>
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

// ─── Settings tab ────────────────────────────────────────────────────
// Holds operator-level toggles. Currently only the temporary "early
// access" password gate that blocks new signups + logins. Flip the
// toggle off to remove the gate instantly; setting the password to
// empty also clears it.
function SettingsTab() {
  const [state, setState] = useState(null);
  const [busy, setBusy]   = useState(false);
  const [pwField, setPwField] = useState('');
  const [showPw, setShowPw]   = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const load = async () => {
    try {
      const r = await api.get('/admin/early-access');
      setState(r);
    } catch (e) {
      setErr(e.message || 'Failed to load gate settings');
    }
  };
  useEffect(() => { load(); }, []);

  const save = async (patch) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.patch('/admin/early-access', patch);
      setState(r);
      setMsg('Saved');
      setTimeout(() => setMsg(null), 2500);
      if ('password' in patch) setPwField('');
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading settings…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Early access password gate</h3>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, maxWidth: 600 }}>
            When this is on, new visitors must enter the access password before
            they can sign up or sign in. Already-signed-in sessions and the
            public booking pages aren't affected. Turn it off to disable.
          </p>
        </div>

        {/* Toggle row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '12px 14px', borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>
              {state.enabled ? 'Gate is ON' : 'Gate is OFF'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {state.enabled
                ? 'Signup and login require the access password.'
                : 'Signup and login are open to anyone.'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => save({ enabled: !state.enabled })}
            disabled={busy || (!state.hasPassword && !state.enabled)}
            className={`btn ${state.enabled ? 'btn-outline' : 'btn-primary'}`}
            title={(!state.hasPassword && !state.enabled) ? 'Set a password before enabling' : ''}
          >
            {state.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>

        {/* Password set / change */}
        <div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)', fontWeight: 500, marginBottom: 6 }}>
            {state.hasPassword ? 'Change password' : 'Set password'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                type={showPw ? 'text' : 'password'}
                value={pwField}
                onChange={(e) => setPwField(e.target.value)}
                placeholder={state.hasPassword ? 'New password' : 'Pick a password (6+ chars)'}
                className="input"
                style={{ width: '100%', padding: '9px 70px 9px 12px', fontSize: 13.5 }}
              />
              <button type="button"
                onClick={() => setShowPw(!showPw)}
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  fontSize: 11, color: 'var(--muted)', padding: '4px 8px',
                }}>
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || pwField.length < 6}
              onClick={() => save({ password: pwField })}
            >
              Save
            </button>
          </div>
          {state.hasPassword && (
            <button
              type="button"
              onClick={() => save({ password: '' })}
              disabled={busy}
              style={{
                marginTop: 8, fontSize: 11.5, color: 'var(--danger)',
                padding: '4px 0', background: 'transparent',
              }}
            >
              Clear password (also turns gate off)
            </button>
          )}
          {state.updatedAt && (
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
              Last changed {new Date(state.updatedAt).toLocaleString()}
            </div>
          )}
        </div>

        {msg && <div style={{ fontSize: 12, color: 'var(--ok)' }}>✓ {msg}</div>}
        {err && <ErrCard msg={err}/>}
      </div>
    </div>
  );
}
