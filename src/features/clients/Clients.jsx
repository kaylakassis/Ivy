// Full Clients view: header + analytics + tabs + search + table + detail drawer + add modal.
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useClients } from './state.js';
import ClientDrawer from './ClientDrawer.jsx';
import AddClientModal from './AddClientModal.jsx';
import ImportClientsModal from './ImportClientsModal.jsx';
import { useViewport } from '../../lib/viewport.js';
import { api } from '../../lib/api.js';

const DAY = 86400e3;

function timeAgo(iso) {
  if (!iso) return null;
  const d = (Date.now() - new Date(iso).getTime()) / DAY;
  if (d < 1) return 'Today';
  if (d < 2) return 'Yesterday';
  if (d < 30) return `${Math.round(d)}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

export default function Clients() {
  const { clients, loading, create, update, remove, refresh,
          hasMore, loadMore, loadingMore } = useClients();
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [leadWindow, setLeadWindow] = useState(30);
  // Customizable window for conversion + churn rate calculations. Default
  // 30 days; owners can dial up to 365 to look at trailing trends.
  const [analyticsWindow, setAnalyticsWindow] = useState(30);
  const [openId, setOpenId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const { isMobile } = useViewport();

  // Bulk metrics keyed by clientId: sessions left, due date, monthly $,
  // 30-day revenue. One round-trip on mount + on `clients` length change
  // (so newly-added clients pick up zero-state metrics immediately).
  const [metricsById, setMetricsById] = useState({});
  useEffect(() => {
    let live = true;
    api.get('/clients/metrics?all=1')
      .then((r) => { if (live) setMetricsById(r.metrics || {}); })
      .catch((e) => console.warn('[Clients] metrics fetch failed:', e.message));
    return () => { live = false; };
  }, [clients.length]);

  // Deep-link support so other pages can route here with a modal opened.
  // Used by Dashboard hero "Add client" and per-client quick actions.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('add') === '1') {
      setAddOpen(true);
      params.delete('add');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
    if (params.get('id')) {
      setOpenId(params.get('id'));
      params.delete('id');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const { active, leads, paused, analytics } = useMemo(() => {
    const now = Date.now();
    const active = clients.filter((c) => c.stage === 'active');
    const leads  = clients.filter((c) => c.stage === 'lead');
    const paused = clients.filter((c) => c.stage === 'paused');
    // Window the conversion + churn calculations to the configurable
    // `analyticsWindow` (default 30d). Picking a longer window smooths
    // out recent noise; shorter zooms in on the latest cohort.
    const windowAgo = now - analyticsWindow * DAY;
    const recentActives = active.filter((c) => new Date(c.joinedAt).getTime() >= windowAgo).length;
    const recentLeads   = leads .filter((c) => new Date(c.joinedAt).getTime() >= windowAgo).length;
    const denomConv = recentActives + recentLeads;
    const conversionRate = denomConv === 0 ? 0 : Math.round((recentActives / denomConv) * 100);
    const churnCount = paused.filter((c) =>
      new Date(c.lastSeenAt || c.joinedAt).getTime() >= windowAgo,
    ).length;
    const denomChurn = active.length + paused.length;
    const churnRate = denomChurn === 0 ? 0 : Math.round((churnCount / denomChurn) * 100);
    const leadsInWindow = leads.filter(
      (c) => (now - new Date(c.joinedAt).getTime()) / DAY <= leadWindow,
    );
    return {
      active, leads, paused,
      analytics: {
        recentActives, recentLeads, conversionRate, churnCount, churnRate,
        leadsInWindow, windowDays: analyticsWindow,
      },
    };
  }, [clients, leadWindow, analyticsWindow]);

  const counts = { all: clients.length, active: active.length, leads: leads.length, paused: paused.length };

  let rows = clients;
  if (tab === 'active') rows = active;
  if (tab === 'leads')  rows = leads;
  if (tab === 'paused') rows = paused;
  if (query.trim()) {
    const q = query.trim().toLowerCase();
    rows = rows.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.tags || []).some((t) => t.toLowerCase().includes(q)),
    );
  }

  const setStage = (id, stage) => update(id, { stage });

  const onAdd = async (input) => {
    await create(input);
    setAddOpen(false);
  };

  const openClient = clients.find((c) => c.id === openId) || null;

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Clients</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            Your book of business - actives, leads, and the ones on pause.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={() => setImportOpen(true)}>
            <Icons.Doc size={13}/> Import CSV
          </button>
          <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
            <Icons.Plus size={13} sw={2}/> Add client
          </button>
        </div>
      </div>

      {/* Analytics */}
      <div className="grid-auto">
        <AnalyticCard label="Total clients" value={active.length + paused.length}
          sub={`${active.length} active · ${paused.length} paused`} icon={<Icons.Users size={16} sw={1.8}/>}/>
        <AnalyticCard
          label={<>Leads in last <EditableNumber value={leadWindow} onChange={setLeadWindow} min={1} max={365}/> days</>}
          value={analytics.leadsInWindow.length}
          sub={`${leads.length} total leads`}
          icon={<Icons.Plus size={16} sw={2}/>}
          tone="accent"/>
        <AnalyticCard
          label={<>Conversion rate · last <EditableNumber value={analyticsWindow} onChange={setAnalyticsWindow} min={1} max={365}/> days</>}
          value={analytics.conversionRate + '%'}
          sub={`${analytics.recentActives}/${analytics.recentActives + analytics.recentLeads} in window`}
          icon={<Icons.Trending size={16} sw={1.8}/>}
          tone={analytics.conversionRate >= 30 ? 'ok' : analytics.conversionRate >= 15 ? 'neutral' : 'warn'}/>
        <AnalyticCard
          label={<>Churn rate · last <EditableNumber value={analyticsWindow} onChange={setAnalyticsWindow} min={1} max={365}/> days</>}
          value={analytics.churnRate + '%'}
          sub={`${analytics.churnCount} paused in window`}
          icon={<Icons.Clock size={16} sw={1.8}/>}
          tone={analytics.churnRate > 20 ? 'bad' : analytics.churnRate > 10 ? 'warn' : 'ok'}/>
      </div>

      {/* Filter + search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="tab-row">
          {[['all','All'],['active','Active'],['leads','Leads'],['paused','Paused']].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 550, cursor: 'pointer',
              background: tab === id ? 'var(--surface)' : 'transparent',
              color: tab === id ? 'var(--fg)' : 'var(--muted)',
              boxShadow: tab === id ? 'var(--shadow-sm)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              {label}
              <span style={{
                fontSize: 10.5, padding: '1px 6px', borderRadius: 99,
                background: tab === id ? 'var(--surface-2)' : 'var(--surface)',
                color: 'var(--muted)', fontWeight: 600,
              }}>{counts[id]}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px',
          borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
        }}>
          <Icons.Search size={13} sw={1.8} stroke="var(--muted)"/>
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email, or tag"
            style={{ border: 0, outline: 0, background: 'transparent', fontSize: 13, width: 200, color: 'var(--fg)' }}/>
        </div>
      </div>

      {/* Table - desktop/tablet keeps the 6-column grid; mobile collapses
          to a stacked card list since six fixed-width columns can't fit
          a phone viewport without horizontal scroll. */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {!isMobile && (
          <div style={{
            display: 'grid', gridTemplateColumns: '1.6fr 100px 1fr 120px 130px 40px',
            padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)', gap: 8,
          }}>
            <div>Client</div><div>Stage</div><div>Health</div><div>Last seen</div>
            <div style={{ textAlign: 'right' }}>Lifetime</div><div/>
          </div>
        )}
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 48 }}>
            <EmptyNote
              icon="Users"
              title={tab === 'all' ? 'No clients yet' : `No ${tab} match`}
              hint={tab === 'all'
                ? 'Add your first client or lead to start your book of business.'
                : 'Try a different tab or clear your search.'}
            />
          </div>
        ) : rows.map((c, i) => (
          isMobile ? (
            <ClientCardMobile key={c.id} client={c} first={i === 0}
              metrics={metricsById[c.id]}
              onOpen={() => setOpenId(c.id)}
              onStage={(st) => setStage(c.id, st)}
              onDelete={() => remove(c.id)}/>
          ) : (
            <ClientRow key={c.id} client={c} first={i === 0}
              metrics={metricsById[c.id]}
              onOpen={() => setOpenId(c.id)}
              onStage={(st) => setStage(c.id, st)}
              onDelete={() => remove(c.id)}/>
          )
        ))}

        {/* Load more - only renders when the server reports a page
            past 1000 rows is available. Tab/search filters operate
            on the loaded set; users with very large books may need
            to load more pages before the filter has anything to
            match against. Plain button (no infinite scroll) - most
            workspaces never hit this, and keyboard accessibility +
            visible state are simpler this way. */}
        {hasMore && tab === 'all' && !query && (
          <div style={{ padding: 16, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              className="btn btn-outline"
              disabled={loadingMore}
              onClick={loadMore}
              style={{ padding: '8px 18px', fontSize: 13 }}>
              {loadingMore ? 'Loading…' : `Load more (${clients.length} loaded)`}
            </button>
          </div>
        )}
      </div>

      {openClient && (
        <ClientDrawer
          client={openClient}
          analyticsWindowDays={analyticsWindow}
          onClose={() => setOpenId(null)}
          onUpdate={(patch) => update(openClient.id, patch)}
          onDelete={async () => { await remove(openClient.id); setOpenId(null); }}
        />
      )}
      {addOpen && <AddClientModal onClose={() => setAddOpen(false)} onAdd={onAdd}/>}
      {importOpen && (
        <ImportClientsModal
          onClose={() => setImportOpen(false)}
          onComplete={() => refresh?.()}
        />
      )}
    </div>
  );
}

function ClientRow({ client, first, metrics, onOpen, onStage, onDelete }) {
  const initials = (client?.name || '').split(' ').map((n) => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  const lastSeen = timeAgo(client.lastSeenAt);

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.6fr 100px 1fr 120px 130px 40px',
      padding: '14px 20px', alignItems: 'center', gap: 8,
      borderTop: first ? 'none' : '1px solid var(--border)',
      cursor: 'pointer', transition: 'background .1s',
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      onClick={onOpen}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 99, flexShrink: 0,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 600,
        }}>{initials || '?'}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {client.name}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {client.email || '-'}
          </div>
        </div>
      </div>
      <div><StageChip stage={client.stage}/></div>
      <ClientMetricsChips metrics={metrics}/>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{lastSeen || '-'}</div>
      <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 600 }} className="mono-num">
        {client.lifetimeValue > 0 ? '$' + client.lifetimeValue.toLocaleString() : '-'}
      </div>
      <div style={{ textAlign: 'right', color: 'var(--muted)' }} onClick={(e) => e.stopPropagation()}>
        <RowMenu client={client} onStage={onStage} onOpen={onOpen} onDelete={onDelete}/>
      </div>
    </div>
  );
}

// Compact chip strip showing the most actionable health signals for a
// client at a glance. Each chip only renders when the underlying value
// is non-zero / present, so silent clients show a clean row.
//
// Order is deliberate:
//   1. sessions left   - most actionable; owners decide who to upsell
//   2. monthly payment - recurring revenue context
//   3. due date        - what needs collecting / billing next
//   4. 30d revenue     - momentum
function ClientMetricsChips({ metrics }) {
  if (!metrics) return <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>-</div>;
  const chips = [];
  if (metrics.sessionsLeft > 0) {
    chips.push({
      key: 'sessions',
      label: `${metrics.sessionsLeft} session${metrics.sessionsLeft === 1 ? '' : 's'} left`,
      tone: metrics.sessionsLeft <= 1 ? 'warn' : 'default',
      title: metrics.sessionsLeft <= 1 ? 'Running low - good time to offer a renewal' : null,
    });
  } else if (metrics.packagesExhausted > 0) {
    chips.push({ key: 'sessions', label: 'Out of sessions', tone: 'warn',
      title: 'Active package is exhausted - offer a renewal' });
  }
  if (metrics.monthlyPaymentCents > 0) {
    chips.push({
      key: 'monthly',
      label: '$' + (metrics.monthlyPaymentCents / 100).toFixed(0) + '/mo',
      tone: 'default',
    });
  }
  if (metrics.dueDate) {
    const d = new Date(metrics.dueDate);
    // Skip the chip rather than render "Invalid Date" if the API returned
    // a malformed timestamp.
    if (!Number.isFinite(d.getTime())) {
      // fall through - no due chip
    } else {
    const days = Math.ceil((d - Date.now()) / 86400e3);
    const fmt = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    let tone = 'default';
    if (days < 0) tone = 'danger';
    else if (days <= 3) tone = 'warn';
    chips.push({
      key: 'due',
      label: `Due ${fmt}`,
      tone,
      title: metrics.dueDateKind === 'invoice'
        ? `Unpaid invoice due ${fmt}` : `Next billing on ${fmt}`,
    });
    }
  }
  if (metrics.revenue30dCents > 0) {
    chips.push({
      key: 'rev30',
      label: '$' + (metrics.revenue30dCents / 100).toFixed(0) + ' / 30d',
      tone: 'default',
    });
  }
  if (chips.length === 0) {
    return <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>-</div>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
      {chips.map((c) => <MetricChip key={c.key} {...c}/>)}
    </div>
  );
}

function MetricChip({ label, tone, title }) {
  const tones = {
    default: { bg: 'var(--surface-2)', fg: 'var(--fg-2)',   bd: 'var(--border)' },
    warn:    { bg: 'rgba(220,180,50,0.10)', fg: '#a78a1f',   bd: 'rgba(220,180,50,0.45)' },
    danger:  { bg: 'rgba(155,44,44,0.10)',  fg: 'var(--danger)', bd: 'rgba(155,44,44,0.45)' },
  };
  const t = tones[tone] || tones.default;
  return (
    <span title={title || undefined} style={{
      fontSize: 11, fontWeight: 500, padding: '2px 7px', borderRadius: 99,
      background: t.bg, color: t.fg, border: '1px solid ' + t.bd,
      whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// Mobile variant - same data, stacked vertically. Two visible lines
// (avatar+name+email, stage chip + last seen + lifetime) so the phone
// shows enough to triage clients without horizontal scroll.
function ClientCardMobile({ client, first, metrics, onOpen, onStage, onDelete }) {
  const initials = (client?.name || '').split(' ').map((n) => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  const lastSeen = timeAgo(client.lastSeenAt);
  return (
    <div
      onClick={onOpen}
      style={{
        padding: '14px 16px',
        borderTop: first ? 'none' : '1px solid var(--border)',
        cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 12,
      }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 99, flexShrink: 0,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 600,
      }}>{initials || '?'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 14, fontWeight: 600,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{client.name}</span>
          {client.lifetimeValue > 0 && (
            <span className="mono-num" style={{ fontSize: 12.5, color: 'var(--fg-2)', flexShrink: 0 }}>
              ${client.lifetimeValue.toLocaleString()}
            </span>
          )}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 4,
          fontSize: 11.5, color: 'var(--muted)',
        }}>
          <StageChip stage={client.stage}/>
          {lastSeen && <span>· Last seen {lastSeen}</span>}
        </div>
        {metrics && (
          <div style={{ marginTop: 6 }}>
            <ClientMetricsChips metrics={metrics}/>
          </div>
        )}
      </div>
      <div onClick={(e) => e.stopPropagation()} style={{ color: 'var(--muted)' }}>
        <RowMenu client={client} onStage={onStage} onOpen={onOpen} onDelete={onDelete}/>
      </div>
    </div>
  );
}

// Renders the menu via React portal so it escapes the table card's overflow:hidden.
// Position is computed from the trigger button's bounding rect on each open.
function RowMenu({ client, onStage, onOpen, onDelete }) {
  const [open, setOpen]   = useState(false);
  const [pos, setPos]     = useState({ top: 0, left: 0 });
  const [confirmDel, setConfirmDel] = useState(false);
  const [busyDel, setBusyDel] = useState(false);
  const [delErr, setDelErr] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const place = () => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const menuW = 200;
    setPos({
      top:  r.bottom + 4,
      left: Math.max(8, r.right - menuW),
    });
  };

  const toggle = () => {
    if (!open) { place(); setConfirmDel(false); setDelErr(null); }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onClick);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onClick);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const stageOpts = [
    { stage: 'active', label: 'Mark active' },
    { stage: 'paused', label: 'Mark paused' },
    { stage: 'lead',   label: 'Mark as lead' },
  ].filter((o) => o.stage !== client.stage);

  const doDelete = async () => {
    setBusyDel(true);
    setDelErr(null);
    try {
      await onDelete();
      setOpen(false);
    } catch (e) {
      setDelErr(e.message || 'Delete failed');
    } finally {
      setBusyDel(false);
    }
  };

  return (
    <>
      <button ref={btnRef} onClick={toggle} className="btn btn-ghost" style={{ padding: 6 }}>
        <Icons.More size={14}/>
      </button>
      {open && createPortal(
        <div ref={menuRef} style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 200,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          borderRadius: 10, boxShadow: 'var(--shadow)', minWidth: 200, padding: 4,
        }}>
          <MenuItem onClick={() => { onOpen(); setOpen(false); }} icon={<Icons.Edit size={13}/>}>
            Open details
          </MenuItem>
          {stageOpts.map((o) => (
            <MenuItem key={o.stage} onClick={() => { onStage(o.stage); setOpen(false); }}>
              {o.label}
            </MenuItem>
          ))}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }}/>
          {confirmDel ? (
            <div style={{ padding: '6px 10px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--danger)', marginBottom: 6 }}>
                Delete {client.name}? This can't be undone.
              </div>
              {delErr && (
                <div style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 6, lineHeight: 1.4 }}>
                  {delErr}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost" disabled={busyDel}
                  style={{ flex: 1, padding: '5px 8px', fontSize: 12, justifyContent: 'center' }}
                  onClick={() => setConfirmDel(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={busyDel}
                  style={{ flex: 1, padding: '5px 8px', fontSize: 12, justifyContent: 'center', background: 'var(--danger)', color: '#fff', opacity: busyDel ? 0.6 : 1 }}
                  onClick={doDelete}>
                  {busyDel ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          ) : (
            <MenuItem danger onClick={() => setConfirmDel(true)} icon={<Icons.Trash size={13}/>}>
              Delete client
            </MenuItem>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function MenuItem({ children, onClick, icon, danger }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      width: '100%', padding: '8px 12px', border: 0, background: 'transparent',
      fontSize: 12.5, color: danger ? 'var(--danger)' : 'var(--fg)',
      cursor: 'pointer', textAlign: 'left', borderRadius: 6,
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {icon}{children}
    </button>
  );
}

export function StageChip({ stage }) {
  const map = {
    active: { fg: 'var(--ok)',     label: 'Active' },
    lead:   { fg: 'var(--accent)', label: 'Lead' },
    paused: { fg: 'var(--muted)',  label: 'Paused' },
  };
  const s = map[stage] || map.active;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 99,
      fontSize: 11, fontWeight: 600,
      background: 'var(--surface-2)', border: '1px solid var(--border)', color: s.fg,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: s.fg }}/>
      {s.label}
    </span>
  );
}

function AnalyticCard({ label, value, sub, icon, tone = 'neutral' }) {
  const colors = {
    ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--danger)',
    accent: 'var(--accent)', neutral: 'var(--muted)',
  };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8, background: 'var(--surface-2)',
          color: colors[tone], flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{icon}</div>
        <div className="metric-label" style={{
          lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{label}</div>
      </div>
      <div className="metric-value" style={{ fontSize: 28 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div>
    </div>
  );
}

function EditableNumber({ value, onChange, min = 1, max = 365 }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  React.useEffect(() => setV(value), [value]);
  if (editing) {
    return (
      <input type="number" value={v} autoFocus min={min} max={max}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { const n = Math.max(min, Math.min(max, Number(v) || value)); onChange(n); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') { setV(value); setEditing(false); }
        }}
        style={{
          width: 48, padding: '1px 4px', borderRadius: 4, fontSize: 11, fontWeight: 700,
          border: '1px solid var(--accent)', background: 'var(--surface)', color: 'var(--accent)',
          textTransform: 'uppercase', fontFamily: 'inherit', outline: 0,
        }}/>
    );
  }
  return (
    <button onClick={() => setEditing(true)} style={{
      display: 'inline-block', padding: '0 4px', borderRadius: 4, border: 0, cursor: 'pointer',
      background: 'var(--accent-soft)', color: 'var(--accent)',
      fontSize: 11, fontWeight: 700, fontFamily: 'inherit', textTransform: 'uppercase',
    }}>{value}</button>
  );
}
