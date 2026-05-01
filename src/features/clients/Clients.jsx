// Full Clients view: header + analytics + tabs + search + table + detail drawer + add modal.
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useClients } from './state.js';
import ClientDrawer from './ClientDrawer.jsx';
import AddClientModal from './AddClientModal.jsx';

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
  const { clients, loading, create, update, remove } = useClients();
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [leadWindow, setLeadWindow] = useState(30);
  const [openId, setOpenId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);

  const { active, leads, paused, analytics } = useMemo(() => {
    const now = Date.now();
    const active = clients.filter((c) => c.stage === 'active');
    const leads  = clients.filter((c) => c.stage === 'lead');
    const paused = clients.filter((c) => c.stage === 'paused');
    const ninetyAgo = now - 90 * DAY;
    const recentActives = active.filter((c) => new Date(c.joinedAt).getTime() >= ninetyAgo).length;
    const recentLeads   = leads .filter((c) => new Date(c.joinedAt).getTime() >= ninetyAgo).length;
    const denomConv = recentActives + recentLeads;
    const conversionRate = denomConv === 0 ? 0 : Math.round((recentActives / denomConv) * 100);
    const churnCount = paused.filter((c) =>
      new Date(c.lastSeenAt || c.joinedAt).getTime() >= ninetyAgo,
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
        leadsInWindow,
      },
    };
  }, [clients, leadWindow]);

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
    <div style={{ padding: '24px 32px 96px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Clients</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            Your book of business — actives, leads, and the ones on pause.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
          <Icons.Plus size={13} sw={2}/> Add client
        </button>
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
        <AnalyticCard label="Conversion rate" value={analytics.conversionRate + '%'}
          sub={`${analytics.recentActives}/${analytics.recentActives + analytics.recentLeads} in last 90d`}
          icon={<Icons.Trending size={16} sw={1.8}/>}
          tone={analytics.conversionRate >= 30 ? 'ok' : analytics.conversionRate >= 15 ? 'neutral' : 'warn'}/>
        <AnalyticCard label="Churn rate" value={analytics.churnRate + '%'}
          sub={`${analytics.churnCount} paused in 90d`}
          icon={<Icons.Clock size={16} sw={1.8}/>}
          tone={analytics.churnRate > 20 ? 'bad' : analytics.churnRate > 10 ? 'warn' : 'ok'}/>
      </div>

      {/* Filter + search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 4, borderRadius: 10 }}>
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

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1.6fr 110px 120px 140px 140px 40px',
          padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
          fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
          background: 'var(--surface-2)',
        }}>
          <div>Client</div><div>Stage</div><div>Since</div><div>Last seen</div>
          <div style={{ textAlign: 'right' }}>Lifetime</div><div/>
        </div>
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
          <ClientRow key={c.id} client={c} first={i === 0}
            onOpen={() => setOpenId(c.id)}
            onStage={(st) => setStage(c.id, st)}
            onDelete={() => remove(c.id)}/>
        ))}
      </div>

      {openClient && (
        <ClientDrawer
          client={openClient}
          onClose={() => setOpenId(null)}
          onUpdate={(patch) => update(openClient.id, patch)}
          onDelete={async () => { await remove(openClient.id); setOpenId(null); }}
        />
      )}
      {addOpen && <AddClientModal onClose={() => setAddOpen(false)} onAdd={onAdd}/>}
    </div>
  );
}

function ClientRow({ client, first, onOpen, onStage, onDelete }) {
  const initials = client.name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase();
  const since    = timeAgo(client.joinedAt);
  const lastSeen = timeAgo(client.lastSeenAt);

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.6fr 110px 120px 140px 140px 40px',
      padding: '14px 20px', alignItems: 'center',
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
            {client.email || '—'}
          </div>
        </div>
      </div>
      <div><StageChip stage={client.stage}/></div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{since || '—'}</div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{lastSeen || '—'}</div>
      <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 600 }} className="mono-num">
        {client.lifetimeValue > 0 ? '$' + client.lifetimeValue.toLocaleString() : '—'}
      </div>
      <div style={{ textAlign: 'right', color: 'var(--muted)' }} onClick={(e) => e.stopPropagation()}>
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
