// IVY PRO - full-page AI business coach.
// Layout: left sidebar (history + new chat), center (chat or welcome), right sidebar (upload + insights).

function IvyProView({ direction }) {
  const [sessions, setSessions] = useIvySessions();
  const [activeId, setActiveId] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [thinking, setThinking] = React.useState(false);
  const [uploads, setUploads] = React.useState([]);
  const scrollRef = React.useRef();

  const active = sessions.find(s => s.id === activeId);

  const send = (text) => {
    const t = (text || draft).trim();
    if (!t) return;
    setDraft('');

    let session = active;
    if (!session) {
      session = { id: 'ivy-' + Date.now(), title: t.slice(0, 40), createdAt: Date.now(), messages: [] };
      setSessions([session, ...sessions]);
      setActiveId(session.id);
    }

    const updated = { ...session, messages: [...session.messages, { role: 'me', text: t, ts: Date.now() }] };
    const nextList = (sessions.find(s => s.id === updated.id) ? sessions : [updated, ...sessions])
      .map(s => s.id === updated.id ? updated : s);
    setSessions(nextList);

    setThinking(true);
    setTimeout(() => {
      const reply = ivyReply(t);
      const withReply = { ...updated, messages: [...updated.messages, { role: 'ivy', text: reply, ts: Date.now() }] };
      setSessions(nextList.map(s => s.id === withReply.id ? withReply : s));
      setThinking(false);
    }, 900);
  };

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [active?.messages?.length, thinking]);

  const newChat = () => { setActiveId(null); setDraft(''); };
  const deleteSession = (id) => {
    setSessions(sessions.filter(s => s.id !== id));
    if (activeId === id) setActiveId(null);
  };

  return (
    <div style={{
      height: 'calc(100vh - 60px)', display: 'grid',
      gridTemplateColumns: '260px 1fr 320px',
      overflow: 'hidden',
    }}>
      {/* LEFT: history */}
      <div style={{
        borderRight: '1px solid var(--border)', background: 'var(--surface)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '20px 18px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 10,
              background: `linear-gradient(135deg, var(--accent), ${direction === 'bold' ? '#E5FF80' : '#5966B8'})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--accent-ink)',
            }}>
              <Icons.Spark size={16} sw={2}/>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 500, letterSpacing: '-0.015em' }}>Ivy Pro</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>AI business coach</div>
            </div>
          </div>
          <button className="btn btn-primary" onClick={newChat} style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}>
            <Icons.Plus size={13} sw={2.2}/> New chat
          </button>
        </div>
        <div style={{
          padding: '4px 12px', fontSize: 10, color: 'var(--muted)', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          Recent
        </div>
        <div className="scroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 16px' }}>
          {sessions.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
              No conversations yet.
            </div>
          ) : sessions.map(s => (
            <button key={s.id} onClick={() => setActiveId(s.id)} style={{
              display: 'flex', width: '100%', padding: '9px 10px', borderRadius: 8,
              border: 0, textAlign: 'left', cursor: 'pointer',
              background: activeId === s.id ? 'var(--surface-2)' : 'transparent',
              color: 'var(--fg)', alignItems: 'center', gap: 8,
            }}
              onMouseEnter={e => { if (activeId !== s.id) e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={e => { if (activeId !== s.id) e.currentTarget.style.background = 'transparent'; }}
            >
              <Icons.Chat size={13} sw={1.8} stroke="var(--muted)"/>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.title}
              </div>
              <span onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }} style={{
                color: 'var(--muted)', opacity: 0.7, padding: 2, display: 'inline-flex',
              }}><Icons.X size={11}/></span>
            </button>
          ))}
        </div>
      </div>

      {/* CENTER */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--surface-2)' }}>
        {/* Insight banner */}
        <div style={{ padding: 24, paddingBottom: 0 }}>
          <InsightBanner direction={direction} onAct={send}/>
        </div>

        {/* Body */}
        <div ref={scrollRef} className="scroll" style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {!active ? (
            <WelcomePanel onPrompt={send} direction={direction}/>
          ) : (
            <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {active.messages.map((m, i) => <ChatBubble key={i} msg={m}/>)}
              {thinking && <ThinkingBubble/>}
            </div>
          )}
        </div>

        {/* Composer */}
        <div style={{ padding: '16px 24px 24px', background: 'var(--surface-2)' }}>
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <div style={{
              display: 'flex', alignItems: 'flex-end', gap: 8,
              padding: 10, borderRadius: 16,
              background: 'var(--surface)', border: '1px solid var(--border-strong)',
              boxShadow: '0 4px 14px -4px rgba(10,12,8,0.08)',
            }}>
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Ask Ivy about revenue, retention, pricing, content…"
                rows={1}
                style={{
                  flex: 1, border: 0, outline: 0, resize: 'none',
                  background: 'transparent', fontFamily: 'inherit', fontSize: 14,
                  lineHeight: 1.5, color: 'var(--fg)', maxHeight: 140, padding: '6px 8px',
                }}/>
              <button className="btn btn-primary" onClick={() => send()} disabled={!draft.trim()}
                style={{ padding: '8px 12px' }}>
                <Icons.Arrow size={13} sw={2.4}/>
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
              Ivy draws on your real Ivy OS data - clients, finance, calendar.
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: uploads + quick context */}
      <div style={{
        borderLeft: '1px solid var(--border)', background: 'var(--surface)',
        padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        <UploadForAnalysis uploads={uploads} setUploads={setUploads} onAnalyze={(u) => send(`Can you analyze the report I just uploaded: "${u.name}"?`)}/>
        <DataContext direction={direction}/>
      </div>
    </div>
  );
}

/* ============ SESSIONS STORE ============ */
const IVY_KEY = 'Ivy OS:ivy';
function loadIvy() {
  try { return JSON.parse(localStorage.getItem(IVY_KEY)) || []; } catch { return []; }
}
function useIvySessions() {
  const [s, setS] = React.useState(loadIvy);
  const update = (next) => { setS(next); localStorage.setItem(IVY_KEY, JSON.stringify(next)); };
  return [s, update];
}

/* ============ REPLIES ============ */
function ivyReply(text) {
  const t = text.toLowerCase();
  // Pull context
  let revenue = 0, openInv = 0, clientCount = 0;
  try {
    const fin = JSON.parse(localStorage.getItem('Ivy OS:finance') || '{}');
    const start = new Date(); start.setDate(1); start.setHours(0,0,0,0);
    revenue = (fin.invoices || []).filter(i => i.status === 'paid' && (i.paidAt||0) >= start.getTime())
      .reduce((s, i) => s + (i.items||[]).reduce((a, it) => a + (it.qty||0)*(it.rate||0), 0), 0);
    openInv = (fin.invoices || []).filter(i => ['sent','overdue'].includes(i.status)).length;
  } catch {}
  try {
    const m = JSON.parse(localStorage.getItem('Ivy OS:messages') || '{}');
    clientCount = (m.clients || []).filter(c => c.registered).length;
  } catch {}

  if (t.includes('revenue') || t.includes('money') || t.includes('income')) {
    return `You're at $${revenue.toLocaleString()} in paid revenue this month. ${openInv > 0 ? `There are ${openInv} open invoices - chasing those could unlock a quick boost.` : 'No open invoices right now.'} Want me to draft a follow-up message for unpaid invoices?`;
  }
  if (t.includes('retention') || t.includes('churn')) {
    return `Retention is about rhythm. Clients who go 3+ weeks without a touchpoint are 4× more likely to churn. Of your ${clientCount} active clients, a few haven't heard from you in a while - I can draft a light check-in to the ones most at risk.`;
  }
  if (t.includes('pricing') || t.includes('rates')) {
    return `A good rule: raise rates when you're >70% booked for 4 weeks straight. I can look at your calendar and last 60 days of bookings to see if you're there. Want me to pull the numbers?`;
  }
  if (t.includes('client acquisition') || t.includes('leads') || t.includes('grow')) {
    return `Three high-leverage moves this week:\n\n1. Post a short case study of a client win on your socials.\n2. Email your 10 most engaged past clients asking for a referral.\n3. Add a clear CTA on your homepage - right now it's doing too much.\n\nWant me to draft any of these?`;
  }
  if (t.includes('content')) {
    return `Your highest-performing content tends to be 'before/after' formats and short FAQs. I can sketch a 4-week content calendar in that vein - want it framed around a single theme, or a mix?`;
  }
  if (t.includes('analyze') && t.includes('report')) {
    return `Got it - I'll treat the upload as your source of truth. Give me a moment... At a glance I'd focus on (1) top 3 revenue sources, (2) any segment with > 15% drop, (3) any cost line growing faster than revenue. Want me to dig into any of those?`;
  }
  if (t.length < 30) {
    return `Happy to dig in. A little more context would help - what's the outcome you're after?`;
  }
  return `Here's how I'd think about this: start by naming the single number that would move most if this worked. From your data, revenue is $${revenue.toLocaleString()} this month with ${clientCount} active clients. I'll sketch a plan rooted in those - want 3 options or one sharp recommendation?`;
}

/* ============ BANNER ============ */
function InsightBanner({ direction, onAct }) {
  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      padding: '18px 20px', borderRadius: 14,
      background: `linear-gradient(110deg, ${direction === 'bold' ? 'var(--accent)' : '#E8E4F2'}, ${direction === 'bold' ? '#E5FF80' : '#D5DBF2'})`,
      color: direction === 'bold' ? 'var(--accent-ink)' : '#2D2847',
      display: 'flex', alignItems: 'center', gap: 16,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, flexShrink: 0,
        background: 'rgba(255,255,255,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Spark size={20} sw={2}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.75 }}>
          Ivy's insight today
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.02em', marginTop: 2 }}>
          Kickstart your client acquisition
        </div>
        <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 3 }}>
          Your lead funnel has slowed this week. Three small moves could reverse it.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button onClick={() => onAct('Help me kickstart client acquisition')} style={{
          padding: '8px 14px', borderRadius: 10, border: 0, cursor: 'pointer',
          background: 'rgba(10,12,8,0.85)', color: 'white', fontSize: 12.5, fontWeight: 600,
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
          Show me how
          <Icons.Arrow size={11} sw={2.4}/>
        </button>
      </div>
    </div>
  );
}

/* ============ WELCOME ============ */
function WelcomePanel({ onPrompt, direction }) {
  const prompts = [
    { icon: <Icons.Dollar size={16} sw={1.8}/>, title: 'Revenue analysis',  body: 'Where is my money coming from this month?', tone: '#0A8A4B' },
    { icon: <Icons.Users size={16} sw={1.8}/>,  title: 'Client retention',  body: 'Which clients are at risk of churning?',   tone: '#4E63C7' },
    { icon: <Icons.Trending size={16} sw={1.8}/>,title:'Pricing strategy', body: 'Am I ready to raise my rates?',             tone: '#C97B22' },
    { icon: <Icons.Calendar size={16} sw={1.8}/>,title:'Content calendar', body: 'Plan my next 4 weeks of posts.',             tone: '#7A33C7' },
    { icon: <Icons.Check size={16} sw={1.8}/>,  title: 'Weekly plan',       body: 'What are the 3 things I should do this week?', tone: '#B23A48' },
    { icon: <Icons.Chat size={16} sw={1.8}/>,   title: 'Client outreach',   body: 'Draft a check-in message to quiet clients.', tone: '#0D7E8A' },
  ];

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14, margin: '0 auto 16px',
          background: `linear-gradient(135deg, var(--accent), ${direction === 'bold' ? '#E5FF80' : '#5966B8'})`,
          color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Spark size={26} sw={1.8}/>
        </div>
        <h2 style={{
          fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 500, letterSpacing: '-0.03em',
          margin: 0, lineHeight: 1.1,
        }}>Welcome to Ivy Pro</h2>
        <div style={{ fontSize: 14, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
          Your AI business coach. Ask anything or start with a prompt below.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
        {prompts.map((p, i) => (
          <button key={i} onClick={() => onPrompt(p.body)} style={{
            padding: 16, borderRadius: 12, cursor: 'pointer', textAlign: 'left',
            background: 'var(--surface)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'flex-start', gap: 12,
            transition: 'transform .12s, box-shadow .12s, border-color .12s',
          }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = '0 6px 18px -8px rgba(10,12,8,0.1)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none'; }}
          >
            <div style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              background: `color-mix(in srgb, ${p.tone} 13%, var(--surface-2))`,
              color: p.tone,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{p.icon}</div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{p.title}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>{p.body}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ============ CHAT BUBBLES ============ */
function ChatBubble({ msg }) {
  const isMe = msg.role === 'me';
  return (
    <div style={{
      display: 'flex', gap: 10, flexDirection: isMe ? 'row-reverse' : 'row',
      alignItems: 'flex-start',
    }}>
      {!isMe && (
        <div style={{
          width: 28, height: 28, borderRadius: 8, flexShrink: 0,
          background: 'linear-gradient(135deg, var(--accent), #E5FF80)',
          color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Spark size={13} sw={2}/>
        </div>
      )}
      <div style={{
        maxWidth: '82%', padding: '11px 15px', borderRadius: 14,
        fontSize: 13.5, lineHeight: 1.55,
        background: isMe ? 'var(--accent)' : 'var(--surface)',
        color: isMe ? 'var(--accent-ink)' : 'var(--fg)',
        border: isMe ? 'none' : '1px solid var(--border)',
        whiteSpace: 'pre-wrap',
      }}>{msg.text}</div>
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8, flexShrink: 0,
        background: 'linear-gradient(135deg, var(--accent), #E5FF80)',
        color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Spark size={13} sw={2}/>
      </div>
      <div style={{
        padding: '11px 15px', borderRadius: 14,
        background: 'var(--surface)', border: '1px solid var(--border)',
        display: 'flex', gap: 5, alignItems: 'center',
      }}>
        {[0,1,2].map(i => (
          <span key={i} style={{
            width: 6, height: 6, borderRadius: 99, background: 'var(--muted)',
            animation: `ivyPulse 1.2s ease-in-out ${i * 0.15}s infinite`,
          }}/>
        ))}
      </div>
      <style>{`@keyframes ivyPulse { 0%,60%,100% { opacity: 0.3; transform: scale(0.9); } 30% { opacity: 1; transform: scale(1.1); } }`}</style>
    </div>
  );
}

/* ============ UPLOAD ============ */
function UploadForAnalysis({ uploads, setUploads, onAnalyze }) {
  const ref = React.useRef();
  const onFiles = (files) => {
    const next = [...uploads];
    for (const f of files) {
      next.push({ name: f.name, size: f.size, ts: Date.now() });
    }
    setUploads(next);
  };

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
        Upload report for analysis
      </div>
      <label htmlFor="ivy-upload" style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        padding: 20, borderRadius: 12, cursor: 'pointer',
        border: '1.5px dashed var(--border-strong)', background: 'var(--surface-2)',
        textAlign: 'center',
      }}
        onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--accent)'; }}
        onDragLeave={e => e.currentTarget.style.borderColor = 'var(--border-strong)'}
        onDrop={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--border-strong)'; onFiles(e.dataTransfer.files); }}
      >
        <div style={{
          width: 36, height: 36, borderRadius: 10, background: 'var(--surface)',
          border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--muted)',
        }}>
          <Icons.Plus size={16} sw={2}/>
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>Drop a CSV, PDF, or image</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
          Ivy will parse your data and give you takeaways.
        </div>
      </label>
      <input id="ivy-upload" ref={ref} type="file" multiple style={{ display: 'none' }}
        onChange={e => { onFiles(e.target.files); e.target.value = ''; }}/>

      {uploads.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {uploads.map((u, i) => (
            <div key={i} style={{
              padding: '8px 10px', borderRadius: 8,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <div style={{
                width: 24, height: 24, borderRadius: 6,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><Icons.Doc size={11} sw={1.8}/></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.name}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)' }}>{Math.round(u.size / 1024)} KB</div>
              </div>
              <button onClick={() => onAnalyze(u)} style={{
                border: 0, background: 'var(--accent)', color: 'var(--accent-ink)',
                fontSize: 10.5, fontWeight: 600, padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
              }}>Analyze</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============ DATA CONTEXT PANEL ============ */
function DataContext({ direction }) {
  const [stats, setStats] = React.useState({ revenue: 0, clients: 0, openInvoices: 0, upcomingSessions: 0 });
  React.useEffect(() => {
    const read = () => {
      let revenue = 0, clients = 0, openInvoices = 0, upcomingSessions = 0;
      try {
        const fin = JSON.parse(localStorage.getItem('Ivy OS:finance') || '{}');
        const start = new Date(); start.setDate(1); start.setHours(0,0,0,0);
        revenue = (fin.invoices || []).filter(i => i.status === 'paid' && (i.paidAt||0) >= start.getTime())
          .reduce((s, i) => s + (i.items||[]).reduce((a, it) => a + (it.qty||0)*(it.rate||0), 0), 0);
        openInvoices = (fin.invoices || []).filter(i => ['sent','overdue'].includes(i.status)).length;
      } catch {}
      try {
        const m = JSON.parse(localStorage.getItem('Ivy OS:messages') || '{}');
        clients = (m.clients || []).filter(c => c.registered).length;
      } catch {}
      try {
        const cal = JSON.parse(localStorage.getItem('Ivy OS:calendar') || '{}');
        upcomingSessions = (cal.events || []).filter(e => (e.start||0) > Date.now() && (e.start||0) < Date.now() + 7*86400e3).length;
      } catch {}
      setStats({ revenue, clients, openInvoices, upcomingSessions });
    };
    read();
    const h = () => read();
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  }, []);

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
        What Ivy sees
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <DataRow label="Revenue this month" value={'$' + stats.revenue.toLocaleString()}/>
        <DataRow label="Active clients" value={stats.clients}/>
        <DataRow label="Open invoices" value={stats.openInvoices} tone={stats.openInvoices > 0 ? 'warn' : 'neutral'}/>
        <DataRow label="Sessions next 7 days" value={stats.upcomingSessions}/>
      </div>
      <div style={{
        marginTop: 12, padding: 10, borderRadius: 8,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        fontSize: 11, lineHeight: 1.5, display: 'flex', gap: 6,
      }}>
        <Icons.Spark size={12} sw={2}/>
        <div>Ivy auto-syncs with Ivy OS. No data leaves your workspace.</div>
      </div>
    </div>
  );
}

function DataRow({ label, value, tone = 'neutral' }) {
  const colors = { warn: 'var(--warn)', neutral: 'var(--fg)' };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)',
    }}>
      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: colors[tone], fontFeatureSettings: '"tnum"' }}>{value}</span>
    </div>
  );
}

window.IvyProView = IvyProView;
