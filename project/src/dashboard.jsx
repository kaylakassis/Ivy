// Dashboard — clean slate. All sections render empty states.

const { METRICS } = window.IVY_DATA;

function fmtMoney(n, { compact } = {}) {
  if (n == null) return '—';
  if (compact && n >= 1000) return '$' + (n/1000).toFixed(n >= 10000 ? 1 : 2).replace(/\.0$/, '') + 'k';
  return '$' + n.toLocaleString('en-US');
}

// ---------- Metric Card ----------
function MetricCard({ k, data, direction }) {
  return (
    <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 128 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="metric-label">{data.label}</span>
        <Icons.More size={16} stroke="var(--muted)" sw={1.8} />
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="metric-value" style={{ fontSize: 38, color: 'var(--muted-2)' }}>—</span>
      </div>
      <div style={{ height: 32, borderTop: '1px dashed var(--border)' }} />
    </div>
  );
}

// ---------- Sparkline (kept for other screens that may call it) ----------
function MiniSpark({ values, direction, height = 32 }) {
  if (!values || values.length < 2) {
    return <div style={{ height, borderTop: '1px dashed var(--border)' }} />;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const W = 200, H = height;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - ((v - min) / range) * (H - 4) - 2;
    return [x, y];
  });
  const path = points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const fill = path + ` L ${W} ${H} L 0 ${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`spk-${direction}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%"  stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill={`url(#spk-${direction})`} />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={points[points.length-1][0]} cy={points[points.length-1][1]} r="2.5" fill="var(--accent)" />
    </svg>
  );
}

// ---------- Revenue chart — empty state ----------
function RevenueChart({ direction }) {
  const W = 600, H = 180;
  return (
    <div className="card" style={{ padding: 24, gridColumn: 'span 2' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <div className="metric-label" style={{ marginBottom: 4 }}>Revenue vs expenses</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
            <span className="metric-value" style={{ fontSize: 28, color: 'var(--muted-2)' }}>—</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Waiting for data</span>
          </div>
        </div>
        <div className="seg">
          {['Week','Month','Year'].map((t, i) => (
            <button key={t} className={i === 0 ? 'on' : ''}>{t}</button>
          ))}
        </div>
      </div>
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
          {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
            <line key={i} x1="0" x2={W} y1={H * (1 - t)} y2={H * (1 - t)}
                  stroke="var(--border)" strokeDasharray={t === 0 ? '0' : '2 3'} />
          ))}
        </svg>
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <EmptyNote icon="Trending" title="No revenue recorded yet"
                     hint="Connect an invoice or payment source and your numbers will populate here." />
        </div>
      </div>
    </div>
  );
}

// ---------- Today's schedule ----------
function TodaySchedule() {
  return (
    <div className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div>
          <div className="metric-label" style={{ marginBottom: 2 }}>Today</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, letterSpacing: '-0.02em' }}>
            Nothing scheduled
          </div>
        </div>
        <button className="btn btn-ghost" style={{ padding: 6 }}><Icons.Plus size={16}/></button>
      </div>
      <EmptyNote icon="Calendar" title="No appointments" hint="Share a booking link or add one manually." />
    </div>
  );
}

// ---------- Activity ----------
function ActivityFeed() {
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
        <span className="metric-label">Activity</span>
        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '2px 6px' }}>View all</button>
      </div>
      <EmptyNote icon="Clock" title="Nothing yet" hint="Payments, messages, and bookings will appear here in real time." />
    </div>
  );
}

// ---------- Tasks ----------
function TaskList() {
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div className="metric-label" style={{ marginBottom: 2 }}>Your list</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, letterSpacing: '-0.02em' }}>
            All clear
          </div>
        </div>
        <button className="btn btn-ghost" style={{ padding: 6 }}><Icons.Plus size={16}/></button>
      </div>
      <EmptyNote icon="Check" title="No tasks" hint="Add one, or ask Ivy to draft your week." />
    </div>
  );
}

// ---------- Empty note ----------
function EmptyNote({ icon, title, hint }) {
  const I = Icons[icon];
  return (
    <div style={{
      padding: '24px 12px', textAlign: 'center',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted)', marginBottom: 4,
      }}><I size={18} /></div>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 240, lineHeight: 1.45 }}>{hint}</div>
    </div>
  );
}

// ---------- Hero band ----------
function HeroBand({ direction }) {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 20,
      padding: '24px 32px',
      background: 'var(--surface)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, letterSpacing: '0.04em' }}>
          {dateStr}
        </div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 36 }}>
          {greet}.
        </h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--fg-2)', maxWidth: 560 }}>
          Welcome to Ivy OS. Add a client or open Ivy &mdash; she&rsquo;ll walk you through setup.
        </p>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-outline"><Icons.Calendar size={14}/>Open calendar</button>
        <button className="btn btn-primary"><Icons.Plus size={14}/>Add client</button>
      </div>
    </div>
  );
}

function Dashboard({ direction }) {
  return (
    <div>
      <HeroBand direction={direction} />
      <div style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          {Object.entries(METRICS).map(([k, data]) => (
            <MetricCard key={k} k={k} data={data} direction={direction} />
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
          <RevenueChart direction={direction} />
          <TodaySchedule />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <ActivityFeed />
          <TaskList />
        </div>
      </div>
    </div>
  );
}

window.Dashboard = Dashboard;
window.fmtMoney = fmtMoney;
window.MiniSpark = MiniSpark;
window.EmptyNote = EmptyNote;
