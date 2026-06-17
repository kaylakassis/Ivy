// GOALS & TASKS — synced across the app where relevant.
// - Tasks: generic to-dos + "smart" tasks that auto-complete from app activity
// - Goals: target-based with progress pulled from finance / clients / sessions

const GOALS_KEY = 'Ivy OS:goals';

function defaultGoals() {
  const now = Date.now(), D = 86400e3;
  return {
    tasks: [
      { id: 't1', title: 'Message Ana about next session', type: 'message-client', clientId: 'c1',
        done: false, dueDate: now + D * 2, createdAt: now - D, source: 'ivy' },
      { id: 't2', title: 'Send invoice to Jordan Cole', type: 'send-invoice', clientId: 'c2',
        done: false, dueDate: now + D * 1, createdAt: now - D, source: 'ivy' },
      { id: 't3', title: 'Follow up with 3 leads from last week', type: 'generic',
        done: false, dueDate: now + D * 3, createdAt: now - D * 2, source: 'user' },
      { id: 't4', title: 'Plan April content calendar', type: 'generic',
        done: true, completedAt: now - D * 1, dueDate: now - D * 1, createdAt: now - D * 4, source: 'user' },
      { id: 't5', title: 'Review last month\'s expenses', type: 'generic',
        done: false, dueDate: now + D * 5, createdAt: now - D * 1, source: 'user' },
    ],
    goals: [
      { id: 'g1', title: 'Reach $5,000 monthly revenue', type: 'revenue', target: 5000,
        deadline: now + D * 20, notes: 'Q2 benchmark. Mostly from retainers + 1:1 coaching.',
        createdAt: now - D * 10 },
      { id: 'g2', title: 'Grow to 20 active clients', type: 'clients', target: 20,
        deadline: now + D * 60, notes: '', createdAt: now - D * 8 },
      { id: 'g3', title: 'Book 40 sessions this month', type: 'sessions', target: 40,
        deadline: now + D * 15, notes: '', createdAt: now - D * 14 },
      { id: 'g4', title: 'Launch website v2', type: 'custom', target: 100, current: 35,
        deadline: now + D * 30, notes: 'Hero + About + Offers sections complete.',
        createdAt: now - D * 20 },
    ],
    nextNotificationCheck: 0,
  };
}

function loadGoals() {
  try { return JSON.parse(localStorage.getItem(GOALS_KEY)) || defaultGoals(); }
  catch { return defaultGoals(); }
}
function saveGoals(s) {
  localStorage.setItem(GOALS_KEY, JSON.stringify(s));
  try { window.dispatchEvent(new StorageEvent('storage', { key: GOALS_KEY })); } catch {}
}
function useGoalsStore() {
  const [s, setS] = React.useState(loadGoals);
  React.useEffect(() => {
    const h = (e) => { if (e.key === GOALS_KEY || e.key == null) setS(loadGoals()); };
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  }, []);
  return [s, (next) => { setS(next); saveGoals(next); }];
}

/* ============ SYNC ENGINE ============ */
// Pulls "current" values for goals from other app stores, and auto-completes tasks
// based on app activity (message sent, invoice sent, etc).
function syncGoalsWithApp() {
  let store = loadGoals();
  let changed = false;
  const notifications = [];

  // --- Tasks auto-complete from app activity
  try {
    const msgs = JSON.parse(localStorage.getItem('Ivy OS:messages') || '{}');
    const fin  = JSON.parse(localStorage.getItem('Ivy OS:finance')  || '{}');

    store.tasks = store.tasks.map(t => {
      if (t.done || t.autoUnchecked) return t;
      let shouldComplete = false;
      if (t.type === 'message-client' && t.clientId) {
        const thread = msgs.threads?.[t.clientId];
        const bizMsgs = (thread?.messages || []).filter(m => m.from === 'biz' && m.ts > t.createdAt);
        if (bizMsgs.length > 0) shouldComplete = true;
      }
      if (t.type === 'send-invoice' && t.clientId) {
        const hit = (fin.invoices || []).some(i => i.clientId === t.clientId && (i.sentAt || 0) > t.createdAt);
        if (hit) shouldComplete = true;
      }
      if (shouldComplete) {
        changed = true;
        notifications.push({
          id: 'n-' + t.id, ts: Date.now(),
          title: 'Task auto-completed', body: t.title,
          source: 'ivy',
        });
        return { ...t, done: true, completedAt: Date.now(), completedAuto: true };
      }
      return t;
    });

    // --- Goals: pull current values
    store.goals = store.goals.map(g => {
      if (g.type === 'revenue') {
        const start = new Date(); start.setDate(1); start.setHours(0,0,0,0);
        const current = (fin.invoices || [])
          .filter(i => i.status === 'paid' && (i.paidAt || 0) >= start.getTime())
          .reduce((s, i) => s + ((i.items||[]).reduce((a, it) => a + (it.qty||0)*(it.rate||0), 0) * (1 - (i.discount||0)/(Math.max(1, (i.items||[]).reduce((a, it) => a + (it.qty||0)*(it.rate||0), 0))))), 0)
          + (fin.transactions || []).filter(t => t.type === 'income' && (t.ts||0) >= start.getTime())
            .reduce((s, t) => s + t.amount, 0);
        if (Math.abs((g.current||0) - current) > 0.5) { changed = true; return { ...g, current: Math.round(current) }; }
        return g;
      }
      if (g.type === 'clients') {
        const count = (msgs.clients || []).filter(c => c.registered).length;
        if (g.current !== count) { changed = true; return { ...g, current: count }; }
        return g;
      }
      if (g.type === 'sessions') {
        try {
          const cal = JSON.parse(localStorage.getItem('Ivy OS:calendar') || '{}');
          const start = new Date(); start.setDate(1); start.setHours(0,0,0,0);
          const count = (cal.events || []).filter(e => (e.start||0) >= start.getTime()).length;
          if (g.current !== count) { changed = true; return { ...g, current: count }; }
        } catch {}
        return g;
      }
      return g; // custom stays as-is
    });
  } catch {}

  if (changed) saveGoals(store);
  return { store, notifications };
}

/* ============ NOTIFICATIONS BUS ============ */
const NOTIF_KEY = 'Ivy OS:notifications';
function pushNotification(n) {
  try {
    const list = JSON.parse(localStorage.getItem(NOTIF_KEY) || '[]');
    list.unshift({ ...n, id: n.id || 'n-' + Date.now() + '-' + Math.random().toString(36).slice(2,5), ts: n.ts || Date.now(), read: false });
    localStorage.setItem(NOTIF_KEY, JSON.stringify(list.slice(0, 50)));
    window.dispatchEvent(new StorageEvent('storage', { key: NOTIF_KEY }));
  } catch {}
}

/* ============ VIEW ============ */
function GoalsView() {
  const [store, update] = useGoalsStore();
  const [tab, setTab] = React.useState(() => localStorage.getItem('Ivy OS:goals:tab') || 'tasks');
  const [syncTick, setSyncTick] = React.useState(0);
  const setTabPers = (t) => { setTab(t); localStorage.setItem('Ivy OS:goals:tab', t); };

  // Run sync on mount + every time the underlying stores change
  React.useEffect(() => {
    const doSync = () => {
      const { notifications } = syncGoalsWithApp();
      notifications.forEach(pushNotification);
      setSyncTick(t => t + 1);
    };
    doSync();
    const h = (e) => {
      if (!e.key || ['Ivy OS:messages','Ivy OS:finance','Ivy OS:calendar',GOALS_KEY].includes(e.key)) doSync();
    };
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  }, []);

  return (
    <div style={{ padding: '24px 32px 96px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 32, letterSpacing: '-0.03em', margin: 0 }}>
            Goals & Tasks
          </h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            Your to-do list and targets — synced with what's happening in Ivy OS.
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border)' }}>
        {[{id:'tasks',label:'Tasks'},{id:'goals',label:'Goals'}].map(t => (
          <button key={t.id} onClick={() => setTabPers(t.id)} style={{
            padding: '10px 18px 12px', border: 0, background: 'none',
            fontSize: 13.5, fontWeight: tab === t.id ? 600 : 500,
            color: tab === t.id ? 'var(--fg)' : 'var(--muted)',
            borderBottom: `2px solid ${tab === t.id ? 'var(--accent)' : 'transparent'}`,
            marginBottom: -1, cursor: 'pointer',
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'tasks' && <TasksPane store={store} update={update}/>}
      {tab === 'goals' && <GoalsPane store={store} update={update}/>}
    </div>
  );
}

/* ============ TASKS ============ */
function TasksPane({ store, update }) {
  const [adding, setAdding] = React.useState(false);
  const [filter, setFilter] = React.useState('open'); // open | all | done

  let tasks = store.tasks.slice().sort((a,b) => (a.done === b.done ? (a.dueDate||0) - (b.dueDate||0) : a.done ? 1 : -1));
  if (filter === 'open') tasks = tasks.filter(t => !t.done);
  if (filter === 'done') tasks = tasks.filter(t => t.done);

  const toggleDone = (id) => {
    update({ ...store, tasks: store.tasks.map(t => t.id === id ? {
      ...t,
      done: !t.done,
      completedAt: !t.done ? Date.now() : undefined,
      autoUnchecked: t.done ? true : t.autoUnchecked, // if we uncheck a auto-completed, mark so we don't re-complete
      completedAuto: !t.done ? t.completedAuto : false,
    } : t) });
  };
  const del = (id) => update({ ...store, tasks: store.tasks.filter(t => t.id !== id) });

  const addTask = (t) => {
    update({ ...store, tasks: [{ ...t, id: 'task-' + Date.now(), createdAt: Date.now(), source: 'user', done: false }, ...store.tasks] });
    setAdding(false);
  };

  const openCount = store.tasks.filter(t => !t.done).length;
  const overdueCount = store.tasks.filter(t => !t.done && t.dueDate && t.dueDate < Date.now()).length;
  const autoCount = store.tasks.filter(t => t.completedAuto).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <MiniKpi label="Open tasks" value={openCount} icon={<Icons.Check size={15} sw={1.8}/>}/>
        <MiniKpi label="Overdue" value={overdueCount} tone={overdueCount > 0 ? 'warn' : 'neutral'} icon={<Icons.Clock size={15} sw={1.8}/>}/>
        <MiniKpi label="Auto-completed by Ivy" value={autoCount} tone="ok" icon={<Icons.Spark size={15} sw={1.8}/>}/>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 4, borderRadius: 10 }}>
          {['open','all','done'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '6px 14px', borderRadius: 7, border: 0, fontSize: 12.5, fontWeight: 550,
              cursor: 'pointer', textTransform: 'capitalize',
              background: filter === f ? 'var(--surface)' : 'transparent',
              color: filter === f ? 'var(--fg)' : 'var(--muted)',
              boxShadow: filter === f ? '0 1px 3px rgba(10,12,8,0.06)' : 'none',
            }}>{f === 'open' ? 'Open' : f === 'done' ? 'Completed' : 'All'}</button>
          ))}
        </div>
        <div style={{ flex: 1 }}/>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <Icons.Plus size={13} sw={2}/> New task
        </button>
      </div>

      {adding && <TaskForm onSave={addTask} onCancel={() => setAdding(false)}/>}

      <div className="card" style={{ overflow: 'hidden' }}>
        {tasks.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
            <Icons.Check size={28} sw={1.4}/>
            <div style={{ fontSize: 13, marginTop: 10 }}>Nothing here.</div>
          </div>
        ) : tasks.map((t, i) => (
          <TaskRow key={t.id} task={t} first={i === 0}
            onToggle={() => toggleDone(t.id)} onDelete={() => del(t.id)}/>
        ))}
      </div>
    </div>
  );
}

function TaskRow({ task, first, onToggle, onDelete }) {
  const overdue = !task.done && task.dueDate && task.dueDate < Date.now();
  const typeIcon = {
    'message-client': <Icons.Chat size={12} sw={1.8}/>,
    'send-invoice':   <Icons.Dollar size={12} sw={1.8}/>,
    'book-client':    <Icons.Calendar size={12} sw={1.8}/>,
    'generic':        null,
  }[task.type];

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '28px 1fr auto 34px', gap: 14,
      padding: '14px 18px', alignItems: 'center',
      borderTop: first ? 'none' : '1px solid var(--border)',
      background: task.done ? 'var(--surface-2)' : 'var(--surface)',
    }}>
      <button onClick={onToggle} style={{
        width: 22, height: 22, borderRadius: 6, border: 0, cursor: 'pointer', padding: 0,
        background: task.done ? 'var(--accent)' : 'var(--surface-2)',
        borderColor: 'var(--border-strong)', borderWidth: task.done ? 0 : 1.5, borderStyle: 'solid',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--accent-ink)',
      }}>
        {task.done && <Icons.Check size={13} sw={2.6}/>}
      </button>

      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 13.5, fontWeight: 550,
          color: task.done ? 'var(--muted)' : 'var(--fg)',
          textDecoration: task.done ? 'line-through' : 'none',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {typeIcon && <span style={{ color: 'var(--muted)' }}>{typeIcon}</span>}
          {task.title}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, display: 'flex', gap: 10, alignItems: 'center' }}>
          {task.dueDate && (
            <span style={{ color: overdue ? 'var(--bad)' : 'var(--muted)' }}>
              Due {new Date(task.dueDate).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              {overdue && ' · overdue'}
            </span>
          )}
          {task.source === 'ivy' && (
            <span style={{
              padding: '1px 8px', borderRadius: 99, background: 'var(--accent-soft)',
              color: 'var(--accent)', fontWeight: 600, fontSize: 10, whiteSpace: 'nowrap',
            }}>From Ivy</span>
          )}
          {task.completedAuto && (
            <span style={{
              padding: '1px 8px', borderRadius: 99, background: 'color-mix(in srgb, var(--ok) 15%, var(--surface-2))',
              color: 'var(--ok)', fontWeight: 600, fontSize: 10, whiteSpace: 'nowrap',
            }}>✓ Auto-synced</span>
          )}
        </div>
      </div>

      <div/>
      <button onClick={onDelete} style={{
        border: 0, background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
        padding: 6, borderRadius: 6,
      }}>
        <Icons.X size={13}/>
      </button>
    </div>
  );
}

function TaskForm({ onSave, onCancel, initial }) {
  const [title, setTitle] = React.useState(initial?.title || '');
  const [type, setType]   = React.useState(initial?.type || 'generic');
  const [clientId, setClientId] = React.useState(initial?.clientId || '');
  const [dueDate, setDueDate] = React.useState(initial?.dueDate
    ? new Date(initial.dueDate).toISOString().slice(0,10)
    : new Date(Date.now() + 2*86400e3).toISOString().slice(0,10));

  const [clients, setClients] = React.useState([]);
  React.useEffect(() => {
    try { setClients((JSON.parse(localStorage.getItem('Ivy OS:messages'))?.clients) || []); } catch {}
  }, []);

  const save = () => {
    if (!title.trim()) return;
    onSave({ title: title.trim(), type, clientId: type === 'generic' ? undefined : clientId, dueDate: new Date(dueDate).getTime() });
  };

  const needsClient = type !== 'generic';

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs doing?"
        style={{
          border: 0, outline: 0, background: 'transparent', fontSize: 15, fontWeight: 550, padding: 0,
        }} autoFocus/>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={type} onChange={e => setType(e.target.value)} style={{
          padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
          fontSize: 12.5, color: 'var(--fg)',
        }}>
          <option value="generic">General task</option>
          <option value="message-client">Message a client</option>
          <option value="send-invoice">Send an invoice</option>
          <option value="book-client">Book a session</option>
        </select>
        {needsClient && (
          <select value={clientId} onChange={e => setClientId(e.target.value)} style={{
            padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
            fontSize: 12.5, color: 'var(--fg)',
          }}>
            <option value="">Choose client…</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={{
          padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
          fontSize: 12.5, color: 'var(--fg)',
        }}/>
        <div style={{ flex: 1 }}/>
        <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={!title.trim() || (needsClient && !clientId)}>
          <Icons.Check size={12} sw={2.4}/> Add task
        </button>
      </div>
      {needsClient && (
        <div style={{ fontSize: 11, color: 'var(--muted)', padding: '6px 10px', background: 'var(--accent-soft)', borderRadius: 6, color: 'var(--accent)' }}>
          <Icons.Spark size={10} sw={2}/> This task will auto-complete when you {type === 'message-client' ? 'message' : type === 'send-invoice' ? 'send an invoice to' : 'book a session with'} the selected client.
        </div>
      )}
    </div>
  );
}

/* ============ GOALS ============ */
function GoalsPane({ store, update }) {
  const [adding, setAdding] = React.useState(false);
  const addGoal = (g) => {
    update({ ...store, goals: [{ ...g, id: 'goal-' + Date.now(), createdAt: Date.now() }, ...store.goals] });
    setAdding(false);
  };
  const updateGoal = (id, patch) => update({ ...store, goals: store.goals.map(g => g.id === id ? { ...g, ...patch } : g) });
  const del = (id) => { if (!confirm('Delete this goal?')) return; update({ ...store, goals: store.goals.filter(g => g.id !== id) }); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', flex: 1 }}>
          Targets pulled from your real app data — financial, client, and session goals update automatically.
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <Icons.Plus size={13} sw={2}/> New goal
        </button>
      </div>

      {adding && <GoalForm onSave={addGoal} onCancel={() => setAdding(false)}/>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
        {store.goals.map(g => <GoalCard key={g.id} goal={g} onUpdate={(p) => updateGoal(g.id, p)} onDelete={() => del(g.id)}/>)}
        {store.goals.length === 0 && (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', gridColumn: '1 / -1' }}>
            <Icons.Trending size={28} sw={1.4}/>
            <div style={{ fontSize: 13, marginTop: 10 }}>No goals yet. Set a target to stay on track.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function GoalCard({ goal, onUpdate, onDelete }) {
  const current = goal.current || 0;
  const progress = Math.min(100, Math.round((current / Math.max(1, goal.target)) * 100));
  const daysLeft = goal.deadline ? Math.round((goal.deadline - Date.now()) / 86400e3) : null;
  const onTrack = progress >= 100 ? 'done' : (daysLeft != null && daysLeft < 0 ? 'missed' : 'active');

  const fmt = (n) => {
    if (goal.type === 'revenue') return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
    return Number(n).toLocaleString('en-US');
  };

  const typeMeta = {
    revenue:  { icon: <Icons.Dollar size={16} sw={1.8}/>, label: 'Revenue',      auto: true,  color: '#0A8A4B' },
    clients:  { icon: <Icons.Users  size={16} sw={1.8}/>, label: 'Clients',      auto: true,  color: '#4E63C7' },
    sessions: { icon: <Icons.Calendar size={16} sw={1.8}/>, label: 'Sessions',   auto: true,  color: '#C97B22' },
    custom:   { icon: <Icons.Spark size={16} sw={1.8}/>, label: 'Custom',         auto: false, color: '#7A33C7' },
  }[goal.type] || {};

  return (
    <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 10,
          background: `color-mix(in srgb, ${typeMeta.color} 15%, var(--surface-2))`,
          color: typeMeta.color,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>{typeMeta.icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{goal.title}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
            {typeMeta.label}{typeMeta.auto ? ' · Auto-synced' : ''}
          </div>
        </div>
        <button onClick={onDelete} style={{
          border: 0, background: 'transparent', color: 'var(--muted)', cursor: 'pointer', padding: 4,
        }}><Icons.X size={13}/></button>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
          <div style={{
            fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1,
          }}>{fmt(current)}</div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>of {fmt(goal.target)}</div>
          <div style={{ flex: 1 }}/>
          <div style={{ fontSize: 12, fontWeight: 600, color: onTrack === 'done' ? 'var(--ok)' : onTrack === 'missed' ? 'var(--bad)' : typeMeta.color }}>
            {progress}%
          </div>
        </div>
        <div style={{ height: 8, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${progress}%`,
            background: onTrack === 'done' ? 'var(--ok)' : typeMeta.color,
            transition: 'width .4s',
          }}/>
        </div>
      </div>

      {!typeMeta.auto && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center', padding: '6px 10px', fontSize: 11.5 }}
            onClick={() => onUpdate({ current: Math.max(0, current - 5) })}>−5</button>
          <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center', padding: '6px 10px', fontSize: 11.5 }}
            onClick={() => onUpdate({ current: Math.min(goal.target, current + 5) })}>+5</button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--muted)' }}>
        <Icons.Clock size={12} sw={1.8}/>
        {goal.deadline ? (
          daysLeft > 0 ? `${daysLeft} days left` :
          daysLeft === 0 ? 'Due today' :
          `${-daysLeft} days overdue`
        ) : 'No deadline'}
        <div style={{ flex: 1 }}/>
        {onTrack === 'done' && <span style={{ color: 'var(--ok)', fontWeight: 600 }}>✓ Achieved</span>}
      </div>

      {goal.notes && (
        <div style={{ fontSize: 12, color: 'var(--fg-2)', padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8, lineHeight: 1.5 }}>
          {goal.notes}
        </div>
      )}
    </div>
  );
}

function GoalForm({ onSave, onCancel }) {
  const [title, setTitle] = React.useState('');
  const [type, setType]   = React.useState('revenue');
  const [target, setTarget] = React.useState('');
  const [deadline, setDeadline] = React.useState(new Date(Date.now() + 30*86400e3).toISOString().slice(0,10));
  const [notes, setNotes] = React.useState('');

  const placeholders = {
    revenue: { t: 'Hit $10,000 in monthly revenue', target: 10000 },
    clients: { t: 'Grow to 25 clients', target: 25 },
    sessions:{ t: 'Run 50 sessions this month', target: 50 },
    custom:  { t: 'Launch my new offer', target: 100 },
  };

  return (
    <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <input value={title} onChange={e => setTitle(e.target.value)}
        placeholder={placeholders[type].t}
        style={{ border: 0, outline: 0, background: 'transparent', fontSize: 17, fontWeight: 550, padding: 0 }} autoFocus/>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Type</div>
          <select value={type} onChange={e => setType(e.target.value)} style={{
            width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 13,
          }}>
            <option value="revenue">Revenue (auto-synced)</option>
            <option value="clients">Clients (auto-synced)</option>
            <option value="sessions">Sessions (auto-synced)</option>
            <option value="custom">Custom (manual)</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Target</div>
          <input type="number" value={target} onChange={e => setTarget(e.target.value)}
            placeholder={String(placeholders[type].target)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 13 }}/>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Deadline</div>
          <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 13 }}/>
        </div>
      </div>
      <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Why does this matter? (optional)"
        style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, fontSize: 13, minHeight: 50, resize: 'vertical', fontFamily: 'inherit', background: 'var(--surface)' }}/>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}/>
        <button className="btn btn-outline" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={() => onSave({ title: title.trim() || placeholders[type].t, type, target: Number(target) || placeholders[type].target, deadline: new Date(deadline).getTime(), notes: notes.trim() })}>
          <Icons.Check size={12} sw={2.4}/> Create goal
        </button>
      </div>
    </div>
  );
}

/* ============ HELPERS ============ */
function MiniKpi({ label, value, tone = 'neutral', icon }) {
  const colors = {
    ok:   'var(--ok)',
    warn: 'var(--warn)',
    bad:  'var(--bad)',
    neutral: 'var(--muted)',
  };
  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <div style={{
          width: 26, height: 26, borderRadius: 7, flexShrink: 0,
          background: 'var(--surface-2)', color: colors[tone],
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{icon}</div>
        <div style={{
          fontSize: 10.5, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.06em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{label}</div>
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>
        {value}
      </div>
    </div>
  );
}

window.GoalsView = GoalsView;
window.GoalsAPI = { loadGoals, saveGoals, pushNotification, syncGoalsWithApp };
