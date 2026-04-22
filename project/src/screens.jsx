// Other nav screens — clean slate.

/* ============ CLIENTS ============ */
function ClientsView() {
  return (
    <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="seg" style={{ padding: 3 }}>
          {['All', 'Active', 'Leads', 'Paused'].map((t, i) => (
            <button key={t} className={i === 0 ? 'on' : ''}>{t}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-outline"><Icons.Filter size={14}/>Filter</button>
        <button className="btn btn-primary"><Icons.Plus size={14}/>Add client</button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 40px',
          gap: 16, padding: '12px 20px', background: 'var(--surface-2)',
          fontSize: 11, fontWeight: 600, color: 'var(--muted)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
          borderBottom: '1px solid var(--border)',
        }}>
          <div>Client</div><div>Stage</div><div>Since</div><div>Last seen</div><div style={{textAlign:'right'}}>Lifetime value</div><div/>
        </div>
        <div style={{ padding: 48 }}>
          <EmptyNote icon="Users" title="No clients yet" hint="Add your first client, or let Ivy pull them from your email." />
        </div>
      </div>
    </div>
  );
}

/* ============ CALENDAR — moved to src/calendar.jsx ============ */

/* ============ FINANCE ============ */
function FinanceView({ direction }) {
  const rows = [
    { label: 'Gross revenue' },
    { label: 'Outstanding' },
    { label: 'Net profit' },
  ];
  return (
    <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
        {rows.map((m, i) => (
          <div key={i} className="card" style={{ padding: 20 }}>
            <div className="metric-label">{m.label}</div>
            <div style={{ display:'flex', alignItems:'baseline', gap: 10, marginTop: 10 }}>
              <span className="metric-value" style={{ fontSize: 34, color: 'var(--muted-2)' }}>—</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>No data</span>
            </div>
            <div style={{ marginTop: 12, height: 40, borderTop: '1px dashed var(--border)' }} />
          </div>
        ))}
      </div>
      <div className="card" style={{ padding: 24 }}>
        <div className="metric-label" style={{ marginBottom: 14 }}>Recent invoices</div>
        <EmptyNote icon="Dollar" title="No invoices yet" hint="Create your first invoice and we&rsquo;ll track payments automatically." />
      </div>
    </div>
  );
}

/* ============ GENERIC STUB ============ */
function StubView({ icon, title, hint }) {
  return (
    <div style={{ padding: 48 }}>
      <div className="card" style={{ padding: 80 }}>
        <EmptyNote icon={icon} title={title} hint={hint} />
      </div>
    </div>
  );
}

/* ============ IVY PANEL ============ */
function IvyPanel({ open, onClose, direction }) {
  const [input, setInput] = React.useState('');
  const [messages, setMessages] = React.useState([
    { role: 'ivy', text: "Hi, I'm Ivy. I'll help you set up and stay on top of things. Ask me anything, or connect your data to begin." },
  ]);
  const send = () => {
    if (!input.trim()) return;
    const mine = input;
    setMessages(m => [...m, { role: 'me', text: mine }]);
    setInput('');
    setTimeout(() => {
      setMessages(m => [...m, { role: 'ivy', text: "Noted. Once your workspace has data I'll come back with something useful." }]);
    }, 700);
  };
  return (
    <>
      <div style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.2)',
        opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity .2s', zIndex: 80,
      }} onClick={onClose} />
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 420,
        background: 'var(--surface)', borderLeft: '1px solid var(--border)',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform .28s cubic-bezier(.2,.8,.2,1)',
        zIndex: 90, display: 'flex', flexDirection: 'column',
        boxShadow: '-20px 0 40px -12px rgba(0,0,0,0.15)',
      }}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10,
            background: `linear-gradient(135deg, var(--accent), ${direction==='bold' ? '#E5FF80' : '#5966B8'})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--accent-ink)',
          }}>
            <Icons.Spark size={18} sw={2}/>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 500, letterSpacing: '-0.015em' }}>Ivy Pro</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--muted-2)' }} />
              Ready when you are
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={16}/></button>
        </div>

        <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
          <div className="metric-label" style={{ marginLeft: 4, marginBottom: 10 }}>Insights</div>
          <div style={{
            padding: 18, borderRadius: 12,
            border: '1px dashed var(--border-strong)', background: 'var(--surface-2)',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>No insights yet</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
              Ivy needs a few clients, sessions, or payments before she can surface patterns.
            </div>
          </div>
        </div>

        <div className="scroll" style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === 'me' ? 'flex-end' : 'flex-start',
              maxWidth: '82%', padding: '9px 13px', borderRadius: 14,
              fontSize: 13, lineHeight: 1.45,
              background: m.role === 'me' ? 'var(--accent)' : 'var(--surface-2)',
              color: m.role === 'me' ? 'var(--accent-ink)' : 'var(--fg)',
              border: m.role === 'me' ? 'none' : '1px solid var(--border)',
            }}>{m.text}</div>
          ))}
        </div>

        <div style={{ padding: 14, borderTop: '1px solid var(--border)' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 6px 6px 12px',
            border: '1px solid var(--border-strong)', borderRadius: 12,
            background: 'var(--surface-2)',
          }}>
            <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&send()}
                   placeholder="Ask Ivy anything…"
                   style={{ flex:1, background:'none', border:0, outline:'none', fontSize: 13 }} />
            <button className="btn btn-primary" style={{ padding: '6px 10px' }} onClick={send}>
              <Icons.Arrow size={13} sw={2.2}/>
            </button>
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['Help me get started', 'Connect my email', 'Set up a booking link'].map(s => (
              <button key={s} className="chip" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
                onClick={()=>{ setInput(s); }}>{s}</button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/* ============ IVY CORNER FAB ============ */
function IvyFab({ onClick, direction }) {
  return (
    <button className="ivy-fab" onClick={onClick} aria-label="Open Ivy"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px 10px 10px',
        borderRadius: 99,
        background: 'var(--surface)',
        border: '1px solid var(--border-strong)',
        boxShadow: '0 10px 30px -6px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.06)',
      }}>
      <div style={{
        width: 30, height: 30, borderRadius: 99,
        background: `linear-gradient(135deg, var(--accent), ${direction==='bold' ? '#E5FF80' : '#5966B8'})`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--accent-ink)',
      }}>
        <Icons.Spark size={15} sw={2.2}/>
      </div>
      <div style={{ textAlign: 'left', lineHeight: 1.15 }}>
        <div style={{ fontSize: 12, fontWeight: 550, color: 'var(--fg)' }}>Ivy</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 500 }}>Ask me anything</div>
      </div>
    </button>
  );
}

window.ClientsView = ClientsView;
window.FinanceView = FinanceView;
window.StubView = StubView;
window.IvyPanel = IvyPanel;
window.IvyFab = IvyFab;
