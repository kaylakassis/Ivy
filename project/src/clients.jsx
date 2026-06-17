// CLIENTS — full CRM view with stages, analytics, and details.
// Source of truth for identity = messages.jsx `clients` list.
// Additional CRM metadata (stage, joinedAt, lastSeen, ltv, notes) stored here.

const CLIENTS_KEY = 'Ivy OS:clients-meta';

function defaultClientsMeta() {
  const now = Date.now(), D = 86400e3;
  return {
    // keyed by client id from messages.jsx
    c1: { stage: 'active', joinedAt: now - D * 95,  lastSeen: now - D * 1,  ltv: 2460, tags: ['retainer','1:1'],      note: 'High-intent. Prefers morning slots.' },
    c2: { stage: 'active', joinedAt: now - D * 62,  lastSeen: now - D * 3,  ltv: 1180, tags: ['programming'],         note: '' },
    c3: { stage: 'paused', joinedAt: now - D * 160, lastSeen: now - D * 45, ltv: 3840, tags: ['quarterly'],           note: 'On break until summer.' },
    c4: { stage: 'lead',   joinedAt: now - D * 9,   lastSeen: now - D * 2,  ltv: 0,    tags: ['referral'],            note: "Came from Ana's referral." },
    c5: { stage: 'active', joinedAt: now - D * 124, lastSeen: now - D * 6,  ltv: 2160, tags: ['studio','membership'], note: '' },
    // sample leads w/o full contact in messages.jsx — will synthesize rows
    _leads: [
      { id: 'ld1', name: 'Marcus Thorne', email: 'marcus.t@example.com', createdAt: now - D * 3,  source: 'Instagram' },
      { id: 'ld2', name: 'Sofia Winters', email: 'sofia.w@example.com',  createdAt: now - D * 5,  source: 'Referral' },
      { id: 'ld3', name: 'Devon Kim',     email: 'devon.k@example.com',  createdAt: now - D * 8,  source: 'Website' },
      { id: 'ld4', name: 'Priya Rao',     email: 'priya.r@example.com',  createdAt: now - D * 11, source: 'Instagram' },
    ],
  };
}

function loadClientsMeta() {
  try { return JSON.parse(localStorage.getItem(CLIENTS_KEY)) || defaultClientsMeta(); }
  catch { return defaultClientsMeta(); }
}
function saveClientsMeta(s) {
  localStorage.setItem(CLIENTS_KEY, JSON.stringify(s));
  try { window.dispatchEvent(new StorageEvent('storage', { key: CLIENTS_KEY })); } catch {}
}
function useClientsMeta() {
  const [s, setS] = React.useState(loadClientsMeta);
  React.useEffect(() => {
    const h = (e) => { if (e.key === CLIENTS_KEY || e.key == null) setS(loadClientsMeta()); };
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  }, []);
  return [s, (next) => { setS(next); saveClientsMeta(next); }];
}

function loadMessagesClients() {
  try { return (JSON.parse(localStorage.getItem('Ivy OS:messages'))?.clients) || []; }
  catch { return []; }
}

/* ============ COMPOSE FULL ROWS ============ */
function composeClients(meta) {
  const baseClients = loadMessagesClients();
  const rows = baseClients.map(c => ({
    id: c.id, name: c.name, email: c.email, accent: c.accent,
    registered: c.registered, isLead: false,
    ...(meta[c.id] || { stage: 'active', joinedAt: Date.now(), lastSeen: null, ltv: 0, tags: [], note: '' }),
  }));
  const leads = (meta._leads || []).map(l => ({
    id: l.id, name: l.name, email: l.email, registered: false, isLead: true,
    stage: 'lead', joinedAt: l.createdAt, lastSeen: l.createdAt, ltv: 0, tags: [l.source || 'Lead'],
    note: '', source: l.source,
  }));
  return [...rows, ...leads];
}

/* ============ MAIN VIEW ============ */
function ClientsView() {
  const [meta, updateMeta] = useClientsMeta();
  const all = composeClients(meta);

  const [tab, setTab] = React.useState(() => localStorage.getItem('Ivy OS:clients:tab') || 'all');
  const [query, setQuery] = React.useState('');
  const [leadWindow, setLeadWindow] = React.useState(() => Number(localStorage.getItem('Ivy OS:clients:leadWindow')) || 30);
  const [openId, setOpenId] = React.useState(null);
  const [addOpen, setAddOpen] = React.useState(false);

  const setTabPers = (t) => { setTab(t); localStorage.setItem('Ivy OS:clients:tab', t); };
  const setLeadWindowPers = (n) => { setLeadWindow(n); localStorage.setItem('Ivy OS:clients:leadWindow', n); };

  /* -- Analytics -- */
  const now = Date.now();
  const active = all.filter(c => c.stage === 'active');
  const leads = all.filter(c => c.stage === 'lead');
  const paused = all.filter(c => c.stage === 'paused');
  const leadsInWindow = leads.filter(c => (now - c.joinedAt) / 86400e3 <= leadWindow);
  // Conversion: how many current-active clients joined (became active) within the last 90 days / total leads + active in 90 days
  const ninetyAgo = now - 90 * 86400e3;
  const recentActives = active.filter(c => c.joinedAt >= ninetyAgo).length;
  const recentLeads   = leads.filter(c => c.joinedAt >= ninetyAgo).length;
  const conversionRate = (recentActives + recentLeads) === 0 ? 0 : Math.round((recentActives / (recentActives + recentLeads)) * 100);
  // Churn: paused in last 90 days / active + paused
  const churnCount = paused.filter(c => (c.lastSeen||c.joinedAt) >= ninetyAgo).length;
  const denom = active.length + paused.length;
  const churnRate = denom === 0 ? 0 : Math.round((churnCount / denom) * 100);
  const totalLTV = all.reduce((s, c) => s + (c.ltv || 0), 0);

  /* -- Filter rows -- */
  let rows = all;
  if (tab === 'active') rows = active;
  if (tab === 'leads')  rows = leads;
  if (tab === 'paused') rows = paused;
  if (query.trim()) {
    const q = query.trim().toLowerCase();
    rows = rows.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.tags||[]).some(t => (t||'').toLowerCase().includes(q))
    );
  }
  rows = rows.slice().sort((a,b) => (b.lastSeen||b.joinedAt||0) - (a.lastSeen||a.joinedAt||0));

  /* -- Actions -- */
  const setStage = (id, stage) => {
    // handle both regular clients (from messages) and leads (in _leads)
    const isLead = (meta._leads || []).some(l => l.id === id);
    if (isLead && stage !== 'lead') {
      // promote lead to active: move them into messages.jsx clients + attach meta
      const lead = (meta._leads || []).find(l => l.id === id);
      try {
        const m = JSON.parse(localStorage.getItem('Ivy OS:messages') || '{}');
        m.clients = m.clients || [];
        m.clients.push({ id: lead.id, name: lead.name, email: lead.email, registered: true, accent: '#D8E8D8' });
        localStorage.setItem('Ivy OS:messages', JSON.stringify(m));
        window.dispatchEvent(new StorageEvent('storage', { key: 'Ivy OS:messages' }));
      } catch {}
      const nextMeta = { ...meta, _leads: (meta._leads||[]).filter(l => l.id !== id) };
      nextMeta[id] = { stage, joinedAt: Date.now(), lastSeen: Date.now(), ltv: 0, tags: [], note: '' };
      updateMeta(nextMeta);
    } else {
      updateMeta({ ...meta, [id]: { ...(meta[id] || {}), stage } });
    }
  };

  const addLead = (lead) => {
    const id = 'ld-' + Date.now();
    updateMeta({
      ...meta,
      _leads: [...(meta._leads || []), { ...lead, id, createdAt: Date.now() }],
    });
    setAddOpen(false);
  };

  const counts = { all: all.length, active: active.length, leads: leads.length, paused: paused.length };

  return (
    <div style={{ padding: '24px 32px 96px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 32, letterSpacing: '-0.03em', margin: 0 }}>
            Clients
          </h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            Your book of business — actives, leads, and the ones on pause.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
          <Icons.Plus size={13} sw={2}/> Add client
        </button>
      </div>

      {/* Analytics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <AnalyticCard label="Total clients" value={active.length + paused.length}
          sub={`${active.length} active · ${paused.length} paused`} icon={<Icons.Users size={16} sw={1.8}/>}/>
        <AnalyticCard
          label={<>Leads in last <EditableNumber value={leadWindow} onChange={setLeadWindowPers} min={1} max={365}/> days</>}
          value={leadsInWindow.length}
          sub={`${leads.length} total leads`}
          icon={<Icons.Plus size={16} sw={2}/>}
          tone="accent"/>
        <AnalyticCard label="Conversion rate" value={conversionRate + '%'}
          sub={`${recentActives}/${recentActives + recentLeads} in last 90d`}
          icon={<Icons.Trending size={16} sw={1.8}/>}
          tone={conversionRate >= 30 ? 'ok' : conversionRate >= 15 ? 'neutral' : 'warn'}/>
        <AnalyticCard label="Churn rate" value={churnRate + '%'}
          sub={`${churnCount} paused in 90d`}
          icon={<Icons.Clock size={16} sw={1.8}/>}
          tone={churnRate > 20 ? 'bad' : churnRate > 10 ? 'warn' : 'ok'}/>
      </div>

      {/* Filter + search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 4, borderRadius: 10 }}>
          {[['all','All'],['active','Active'],['leads','Leads'],['paused','Paused']].map(([id,label]) => (
            <button key={id} onClick={() => setTabPers(id)} style={{
              padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 550, cursor: 'pointer',
              background: tab === id ? 'var(--surface)' : 'transparent',
              color: tab === id ? 'var(--fg)' : 'var(--muted)',
              boxShadow: tab === id ? '0 1px 3px rgba(10,12,8,0.06)' : 'none',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              {label}
              <span style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 99, background: tab===id ? 'var(--surface-2)' : 'var(--surface)', color: 'var(--muted)', fontWeight: 600 }}>
                {counts[id]}
              </span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px',
          borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
        }}>
          <Icons.Search size={13} sw={1.8} stroke="var(--muted)"/>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name, email, or tag"
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
        {rows.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)' }}>
            <Icons.Users size={28} sw={1.4}/>
            <div style={{ fontSize: 13, marginTop: 8 }}>No {tab === 'all' ? 'clients' : tab} match.</div>
          </div>
        ) : rows.map((c, i) => (
          <ClientRow key={c.id} client={c} first={i === 0} onOpen={() => setOpenId(c.id)} onStage={(st) => setStage(c.id, st)}/>
        ))}
      </div>

      {openId && <ClientDetail client={all.find(c => c.id === openId)} onClose={() => setOpenId(null)}
        onStage={(st) => setStage(openId, st)}
        onUpdate={(patch) => updateMeta({ ...meta, [openId]: { ...(meta[openId]||{}), ...patch } })}/>}
      {addOpen && <AddClientModal onClose={() => setAddOpen(false)} onAdd={addLead}/>}
    </div>
  );
}

function ClientRow({ client, first, onOpen, onStage }) {
  const initials = client.name.split(' ').map(n => n[0]).slice(0,2).join('').toUpperCase();
  const since = client.joinedAt ? Math.round((Date.now() - client.joinedAt) / 86400e3) : null;
  const lastSeen = client.lastSeen ? Math.round((Date.now() - client.lastSeen) / 86400e3) : null;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.6fr 110px 120px 140px 140px 40px',
      padding: '14px 20px', alignItems: 'center',
      borderTop: first ? 'none' : '1px solid var(--border)',
      cursor: 'pointer', transition: 'background .1s',
    }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      onClick={onOpen}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 99, flexShrink: 0,
          background: client.accent || 'var(--surface-2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 600, color: 'var(--fg)',
        }}>{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {client.name}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {client.email}
          </div>
        </div>
      </div>
      <div><StageChip stage={client.stage}/></div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
        {since != null ? (since === 0 ? 'Today' : since < 30 ? `${since}d ago` : since < 365 ? `${Math.round(since/30)}mo ago` : `${Math.round(since/365)}y ago`) : '—'}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
        {lastSeen != null ? (lastSeen === 0 ? 'Today' : lastSeen === 1 ? 'Yesterday' : `${lastSeen}d ago`) : '—'}
      </div>
      <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 600, fontFeatureSettings: '"tnum"' }}>
        {client.ltv > 0 ? '$' + client.ltv.toLocaleString() : '—'}
      </div>
      <div style={{ textAlign: 'right', color: 'var(--muted)' }} onClick={e => e.stopPropagation()}>
        <RowMenu client={client} onStage={onStage}/>
      </div>
    </div>
  );
}

function RowMenu({ client, onStage }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef();
  React.useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, []);
  const opts = [
    { stage: 'active', label: 'Mark active' },
    { stage: 'paused', label: 'Mark paused' },
    { stage: 'lead',   label: 'Mark as lead' },
  ].filter(o => o.stage !== client.stage);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => setOpen(!open)} style={{
        border: 0, background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
        padding: 6, borderRadius: 6,
      }}>
        <Icons.More size={14}/>
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 10,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 10px 30px rgba(10,12,8,0.15)', minWidth: 160, padding: 4,
        }}>
          {opts.map(o => (
            <button key={o.stage} onClick={() => { onStage(o.stage); setOpen(false); }} style={{
              display: 'block', width: '100%', padding: '8px 12px', border: 0, background: 'transparent',
              fontSize: 12.5, color: 'var(--fg)', cursor: 'pointer', textAlign: 'left', borderRadius: 6,
            }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function StageChip({ stage }) {
  const map = {
    active: { bg: 'color-mix(in srgb, var(--ok) 14%, var(--surface))', fg: 'var(--ok)', label: 'Active' },
    lead:   { bg: 'color-mix(in srgb, var(--accent) 14%, var(--surface))', fg: 'var(--accent)', label: 'Lead' },
    paused: { bg: 'var(--surface-2)', fg: 'var(--muted)', label: 'Paused' },
  };
  const s = map[stage] || map.active;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 99,
      fontSize: 11, fontWeight: 600, background: s.bg, color: s.fg,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: s.fg }}/>
      {s.label}
    </span>
  );
}

function AnalyticCard({ label, value, sub, icon, tone = 'neutral' }) {
  const colors = {
    ok:   'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)',
    accent: 'var(--accent)', neutral: 'var(--muted)',
  };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8, background: 'var(--surface-2)', color: colors[tone], flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{icon}</div>
        <div style={{ fontSize: 10.5, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </div>
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div>
    </div>
  );
}

function EditableNumber({ value, onChange, min = 1, max = 365 }) {
  const [editing, setEditing] = React.useState(false);
  const [v, setV] = React.useState(value);
  React.useEffect(() => setV(value), [value]);
  if (editing) {
    return (
      <input type="number" value={v} autoFocus min={min} max={max}
        onChange={e => setV(e.target.value)}
        onBlur={() => { const n = Math.max(min, Math.min(max, Number(v) || value)); onChange(n); setEditing(false); }}
        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setV(value); setEditing(false); } }}
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
    }}>
      {value}
    </button>
  );
}

/* ============ DETAIL DRAWER ============ */
function ClientDetail({ client, onClose, onStage, onUpdate }) {
  if (!client) return null;
  const initials = client.name.split(' ').map(n => n[0]).slice(0,2).join('').toUpperCase();
  const [noteDraft, setNoteDraft] = React.useState(client.note || '');
  const [tagInput, setTagInput] = React.useState('');

  // Load related data
  const [recentInvoices, setRecentInvoices] = React.useState([]);
  const [recentMessages, setRecentMessages] = React.useState([]);
  React.useEffect(() => {
    try {
      const fin = JSON.parse(localStorage.getItem('Ivy OS:finance') || '{}');
      setRecentInvoices((fin.invoices || []).filter(i => i.clientId === client.id).slice(0, 3));
    } catch {}
    try {
      const m = JSON.parse(localStorage.getItem('Ivy OS:messages') || '{}');
      setRecentMessages((m.threads?.[client.id]?.messages || []).slice(-3).reverse());
    } catch {}
  }, [client.id]);

  const saveNote = () => onUpdate({ note: noteDraft });
  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    onUpdate({ tags: [...(client.tags || []), t] });
    setTagInput('');
  };
  const removeTag = (t) => onUpdate({ tags: (client.tags||[]).filter(x => x !== t) });

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(10,12,8,0.5)', zIndex: 110,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 560, background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{
            width: 52, height: 52, borderRadius: 99, flexShrink: 0,
            background: client.accent || 'var(--surface-2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, fontWeight: 600, color: 'var(--fg)',
          }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{client.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{client.email}</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Stage switch */}
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Stage</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {['active','lead','paused'].map(s => (
                <button key={s} onClick={() => onStage(s)} style={{
                  flex: 1, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 550,
                  textTransform: 'capitalize', cursor: 'pointer',
                  border: '1px solid ' + (client.stage === s ? 'var(--accent)' : 'var(--border)'),
                  background: client.stage === s ? 'var(--accent-soft)' : 'var(--surface)',
                  color: client.stage === s ? 'var(--accent)' : 'var(--fg-2)',
                }}>{s}</button>
              ))}
            </div>
          </div>

          {/* KPIs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <MiniStat label="Lifetime" value={client.ltv > 0 ? '$' + client.ltv.toLocaleString() : '—'}/>
            <MiniStat label="Since" value={client.joinedAt ? new Date(client.joinedAt).toLocaleDateString([], { month: 'short', year: '2-digit' }) : '—'}/>
            <MiniStat label="Last seen" value={client.lastSeen ? Math.round((Date.now()-client.lastSeen)/86400e3) + 'd ago' : '—'}/>
          </div>

          {/* Tags */}
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Tags</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {(client.tags || []).map(t => (
                <span key={t} style={{
                  padding: '3px 10px', borderRadius: 99, background: 'var(--surface-2)',
                  border: '1px solid var(--border)', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                  {t}
                  <button onClick={() => removeTag(t)} style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, color: 'var(--muted)' }}>
                    <Icons.X size={10}/>
                  </button>
                </span>
              ))}
              <input value={tagInput} onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addTag()}
                placeholder="+ add tag"
                style={{
                  padding: '3px 10px', borderRadius: 99, border: '1px dashed var(--border-strong)',
                  background: 'transparent', fontSize: 11.5, outline: 0, width: 100, color: 'var(--fg)',
                }}/>
            </div>
          </div>

          {/* Note */}
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Private note</div>
            <textarea value={noteDraft} onChange={e => setNoteDraft(e.target.value)} onBlur={saveNote}
              placeholder="Anything useful to remember about this client…"
              style={{
                width: '100%', padding: 12, borderRadius: 10, fontFamily: 'inherit', fontSize: 13,
                border: '1px solid var(--border-strong)', background: 'var(--surface-2)',
                color: 'var(--fg)', minHeight: 70, resize: 'vertical', outline: 0,
              }}/>
          </div>

          {/* Recent invoices */}
          {recentInvoices.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Recent invoices</div>
              <div className="card" style={{ overflow: 'hidden' }}>
                {recentInvoices.map((i, idx) => (
                  <div key={i.id} style={{
                    padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
                    borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                  }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, fontFeatureSettings: '"tnum"' }}>{i.number}</div>
                    <div style={{ flex: 1, fontSize: 11.5, color: 'var(--muted)' }}>
                      {new Date(i.issueDate).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, fontFeatureSettings: '"tnum"' }}>
                      ${(i.items||[]).reduce((s, it) => s + (it.qty||0)*(it.rate||0), 0).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent messages */}
          {recentMessages.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Recent messages</div>
              <div className="card" style={{ overflow: 'hidden' }}>
                {recentMessages.map((msg, idx) => (
                  <div key={idx} style={{
                    padding: '10px 14px', display: 'flex', gap: 10,
                    borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                  }}>
                    <div style={{
                      padding: '2px 8px', borderRadius: 99, fontSize: 10, fontWeight: 600,
                      background: msg.from === 'biz' ? 'var(--accent-soft)' : 'var(--surface-2)',
                      color: msg.from === 'biz' ? 'var(--accent)' : 'var(--muted)',
                      height: 'fit-content', flexShrink: 0,
                    }}>{msg.from === 'biz' ? 'You' : 'Them'}</div>
                    <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg-2)' }}>
                      {msg.text}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8,
        }}>
          <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }}>
            <Icons.Chat size={13} sw={1.8}/> Message
          </button>
          <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }}>
            <Icons.Dollar size={13} sw={1.8}/> Invoice
          </button>
          <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }}>
            <Icons.Calendar size={13} sw={1.8}/> Book session
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3, fontFeatureSettings: '"tnum"' }}>{value}</div>
    </div>
  );
}

/* ============ ADD CLIENT ============ */
function AddClientModal({ onClose, onAdd }) {
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [source, setSource] = React.useState('Referral');
  const canAdd = name.trim() && email.trim();
  const sources = ['Referral','Instagram','Website','Email','Walk-in','Other'];

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(10,12,8,0.5)', zIndex: 120,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ padding: 28, width: '100%', maxWidth: 440 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Users size={16} sw={1.8}/></div>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, flex: 1 }}>Add new lead</h3>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={15}/></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name"
            style={{
              padding: '10px 12px', border: '1px solid var(--border-strong)', borderRadius: 10,
              fontSize: 14, background: 'var(--surface)', color: 'var(--fg)', outline: 0,
            }}/>
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email"
            style={{
              padding: '10px 12px', border: '1px solid var(--border-strong)', borderRadius: 10,
              fontSize: 14, background: 'var(--surface)', color: 'var(--fg)', outline: 0,
            }}/>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Source</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {sources.map(s => (
                <button key={s} onClick={() => setSource(s)} style={{
                  padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 550, cursor: 'pointer',
                  border: '1px solid ' + (source === s ? 'var(--accent)' : 'var(--border)'),
                  background: source === s ? 'var(--accent-soft)' : 'var(--surface)',
                  color: source === s ? 'var(--accent)' : 'var(--fg-2)',
                }}>{s}</button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}
            disabled={!canAdd} onClick={() => onAdd({ name: name.trim(), email: email.trim(), source })}>
            <Icons.Plus size={12} sw={2.2}/> Add as lead
          </button>
        </div>
      </div>
    </div>
  );
}

window.ClientsView = ClientsView;
