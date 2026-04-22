// Rewards — landing pitch + full program manager once launched.

const REWARDS_LAUNCHED_KEY = 'thryve:rewards-launched';

function RewardsView({ direction }) {
  const [launched, setLaunched] = React.useState(() => localStorage.getItem(REWARDS_LAUNCHED_KEY) === '1');
  const onLaunch = () => { localStorage.setItem(REWARDS_LAUNCHED_KEY, '1'); setLaunched(true); };
  const onReset  = () => { localStorage.removeItem(REWARDS_LAUNCHED_KEY); setLaunched(false); };
  return launched
    ? <RewardsManager direction={direction} onReset={onReset} />
    : <RewardsLanding direction={direction} onLaunch={onLaunch} />;
}

/* ========== LANDING ========== */

function RewardsLanding({ direction, onLaunch }) {
  const stats = [
    { value: '67%',    color: 'var(--ok)',     tone: 'ok',
      body: 'Repeat customers spend 67% more than new customers.', src: 'Bain & Company' },
    { value: '60–70%', color: 'var(--accent)', tone: 'accent',
      body: 'Probability of selling to an existing customer vs. 5–20% for new ones.', src: 'Invesp' },
    { value: '2.5×',   color: 'var(--warn)',   tone: 'warn',
      body: 'Businesses with loyalty programs grow revenue 2.5× faster.', src: 'Annex Cloud' },
  ];
  const offerings = [
    { title: 'Visit-based rewards',   body: 'Book 5, get 1 free.' },
    { title: 'Spend-based rewards',   body: 'Spend $300, get $25 credit.' },
    { title: 'Referral bonuses',      body: 'Refer a friend — both get rewarded.' },
    { title: 'Custom rules',          body: 'Design your own loyalty program.' },
  ];

  return (
    <div style={{ padding: '48px 32px 80px', maxWidth: 820, margin: '0 auto' }}>
      {/* Icon badge */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, marginBottom: 40 }}>
        <div style={{
          width: 72, height: 72, borderRadius: 999,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 12px 30px -12px color-mix(in srgb, var(--accent) 70%, transparent)',
        }}>
          <Icons.Gift size={34} sw={1.8} />
        </div>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontWeight: 500,
            fontSize: 42, letterSpacing: '-0.03em', lineHeight: 1.05,
            margin: '0 0 10px',
          }}>Welcome to Client Rewards</h1>
          <p style={{ fontSize: 16, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
            Transform one-time visitors into loyal, repeat customers.
          </p>
        </div>
      </div>

      {/* Why */}
      <div className="card" style={{ padding: 28, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}><Icons.Spark size={18} sw={1.7} /></div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>
              Why reward programs work
            </h3>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              The goal isn't just to grow your business — it's to help you understand
              the <i>why</i> behind what works. Every tool here is designed to make you
              a smarter, more profitable business owner.
            </p>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {stats.map((s, i) => (
            <StatTile key={i} {...s} />
          ))}
        </div>
      </div>

      {/* What you can do */}
      <div className="card" style={{ padding: 28, marginBottom: 28 }}>
        <h3 style={{ margin: '0 0 18px', fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>
          What you can do
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          {offerings.map((o, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{
                width: 24, height: 24, borderRadius: 999,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, marginTop: 1,
              }}>
                <Icons.Check size={13} sw={2.2} />
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{o.title}</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.45 }}>{o.body}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-primary" onClick={onLaunch} style={{
          padding: '14px 28px', fontSize: 15, fontWeight: 600, gap: 10,
          boxShadow: '0 12px 24px -10px color-mix(in srgb, var(--accent) 60%, transparent)',
        }}>
          Set up my first reward program
          <Icons.Arrow size={16} sw={2} />
        </button>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Takes less than 2 minutes · Free with all plans
        </div>
      </div>
    </div>
  );
}

function StatTile({ value, body, src, tone }) {
  const bg = {
    ok:     'color-mix(in srgb, var(--ok)     14%, var(--surface))',
    accent: 'color-mix(in srgb, var(--accent) 14%, var(--surface))',
    warn:   'color-mix(in srgb, var(--warn)   14%, var(--surface))',
  }[tone];
  const fg = {
    ok: 'var(--ok)', accent: 'var(--accent)', warn: 'var(--warn)',
  }[tone];
  const Icon = { ok: Icons.Trending, accent: Icons.Users, warn: Icons.Heart }[tone];
  return (
    <div style={{
      padding: 18, borderRadius: 12,
      background: bg, border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8,
    }}>
      <Icon size={18} stroke={fg} sw={1.8} />
      <div style={{
        fontFamily: 'var(--font-num)', fontWeight: 600,
        fontSize: 32, letterSpacing: '-0.03em', color: fg, lineHeight: 1,
      }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.45 }}>{body}</div>
      <div style={{ fontSize: 10, color: 'var(--muted-2)', marginTop: 2, letterSpacing: '0.02em' }}>— {src}</div>
    </div>
  );
}

/* ========== MANAGER (after launch) ========== */

function RewardsManager({ direction, onReset }) {
  const [tab, setTab] = React.useState('rules');
  const [rules, setRules] = React.useState([
    { id: 'r1', type: 'visit',    name: 'Book 5, get 1 free',     trigger: 'After 5 booked services', reward: '1 free session', active: true,  members: 14 },
    { id: 'r2', type: 'referral', name: 'Friend referral',        trigger: 'New referred client books', reward: '$25 credit for both', active: true,  members: 6 },
    { id: 'r3', type: 'spend',    name: 'Spend $300, get $25',    trigger: 'Cumulative spend $300',   reward: '$25 account credit', active: false, members: 0 },
  ]);
  const [editing, setEditing] = React.useState(null);

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 1180, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 28 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 600, marginBottom: 6 }}>
            Program live
          </div>
          <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 32, letterSpacing: '-0.03em' }}>
            Client rewards
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--muted)' }}>
            Tune your loyalty rules and keep an eye on what's moving the needle.
          </p>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={onReset} style={{ fontSize: 12, color: 'var(--muted)' }}>
          Reset program
        </button>
        <button className="btn btn-primary" onClick={() => setEditing({ id: null, type: 'visit', name: '', trigger: '', reward: '', active: true })}>
          <Icons.Plus size={14} sw={2} /> New rule
        </button>
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
        <KPI label="Active members" value="20" delta="+4 this week" />
        <KPI label="Rewards redeemed" value="7" delta="+2 this week" />
        <KPI label="Revenue from repeats" value="$2,340" delta="+18% MoM" positive />
        <KPI label="Referrals converted" value="6" delta="3 pending" />
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 4, padding: 4, borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        marginBottom: 18, width: 'fit-content',
      }}>
        {['rules','members','redemptions'].map(x => (
          <button key={x} onClick={() => setTab(x)} style={{
            padding: '7px 14px', borderRadius: 7,
            background: tab === x ? 'var(--surface)' : 'transparent',
            color: tab === x ? 'var(--fg)' : 'var(--muted)',
            fontWeight: 550, fontSize: 13, textTransform: 'capitalize',
            border: tab === x ? '1px solid var(--border)' : '1px solid transparent',
          }}>{x}</button>
        ))}
      </div>

      {tab === 'rules' && (
        <div style={{ display: 'grid', gap: 10 }}>
          {rules.map(r => (
            <RuleRow key={r.id} rule={r}
              onEdit={() => setEditing(r)}
              onToggle={() => setRules(rules.map(x => x.id === r.id ? { ...x, active: !x.active } : x))}
            />
          ))}
        </div>
      )}

      {tab === 'members' && <MembersTable />}
      {tab === 'redemptions' && <RedemptionsTable />}

      {editing && (
        <RuleEditor rule={editing}
          onSave={(saved) => {
            if (saved.id) setRules(rules.map(r => r.id === saved.id ? saved : r));
            else          setRules([...rules, { ...saved, id: 'r' + Date.now(), members: 0 }]);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function KPI({ label, value, delta, positive }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ fontSize: 30, marginTop: 8 }}>{value}</div>
      <div style={{ fontSize: 12, color: positive ? 'var(--ok)' : 'var(--muted)', marginTop: 6 }}>{delta}</div>
    </div>
  );
}

function RuleRow({ rule, onEdit, onToggle }) {
  const icon = { visit: Icons.Calendar, spend: Icons.Dollar, referral: Icons.Users }[rule.type] || Icons.Gift;
  const IconC = icon;
  return (
    <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: rule.active ? 'var(--accent-soft)' : 'var(--surface-2)',
        color: rule.active ? 'var(--accent)' : 'var(--muted)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}><IconC size={18} sw={1.7} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{
            fontWeight: 600, fontSize: 14,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            minWidth: 0,
          }}>{rule.name}</span>
          <span className="chip" style={{ fontSize: 10, padding: '2px 7px', textTransform: 'capitalize', flexShrink: 0 }}>{rule.type}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          <b style={{ color: 'var(--fg-2)', fontWeight: 550 }}>When:</b> {rule.trigger}
          <span style={{ margin: '0 8px', color: 'var(--border-strong)' }}>·</span>
          <b style={{ color: 'var(--fg-2)', fontWeight: 550 }}>Reward:</b> {rule.reward}
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'right', minWidth: 70 }}>
        <div style={{ fontWeight: 600, color: 'var(--fg)', fontSize: 14 }} className="mono-num">{rule.members}</div>
        <div>members</div>
      </div>
      <Toggle on={rule.active} onClick={onToggle} />
      <button className="btn btn-outline" onClick={onEdit}>Edit</button>
    </div>
  );
}

function Toggle({ on, onClick }) {
  return (
    <button onClick={onClick} style={{
      width: 38, height: 22, borderRadius: 99,
      background: on ? 'var(--accent)' : 'var(--surface-2)',
      border: `1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
      position: 'relative', transition: 'background .15s',
    }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 18 : 2,
        width: 16, height: 16, borderRadius: 99, background: on ? 'var(--accent-ink)' : '#fff',
        transition: 'left .15s',
      }} />
    </button>
  );
}

function RuleEditor({ rule, onSave, onClose }) {
  const [draft, setDraft] = React.useState(rule);
  const types = [
    { id: 'visit',    label: 'Visit-based',    hint: 'After N booked services' },
    { id: 'spend',    label: 'Spend-based',    hint: 'After cumulative spend' },
    { id: 'referral', label: 'Referral',       hint: 'When a referred client books' },
    { id: 'custom',   label: 'Custom',         hint: 'Write your own trigger' },
  ];
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10,12,8,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20,
    }} onClick={onClose}>
      <div className="card" style={{ width: '100%', maxWidth: 560, padding: 28 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>
              {rule.id ? 'Edit rule' : 'New rule'}
            </div>
            <h3 style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>
              Design your loyalty rule
            </h3>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>✕</button>
        </div>

        <Field label="Rule type">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {types.map(t => (
              <button key={t.id} onClick={() => setDraft({ ...draft, type: t.id })} style={{
                padding: 12, borderRadius: 10, textAlign: 'left',
                background: draft.type === t.id ? 'var(--accent-soft)' : 'var(--surface-2)',
                border: `1px solid ${draft.type === t.id ? 'var(--accent)' : 'var(--border)'}`,
              }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{t.label}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{t.hint}</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Name this rule">
          <Input value={draft.name} onChange={v => setDraft({ ...draft, name: v })} placeholder="Book 5, get 1 free" />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Trigger">
            <Input value={draft.trigger} onChange={v => setDraft({ ...draft, trigger: v })} placeholder="After 5 booked services" />
          </Field>
          <Field label="Reward">
            <Input value={draft.reward} onChange={v => setDraft({ ...draft, reward: v })} placeholder="1 free session" />
          </Field>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
          background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, marginTop: 6 }}>
          <Toggle on={draft.active} onClick={() => setDraft({ ...draft, active: !draft.active })} />
          <div style={{ fontSize: 13 }}>
            <b>{draft.active ? 'Active' : 'Paused'}</b>
            <span style={{ color: 'var(--muted)', marginLeft: 6 }}>
              {draft.active ? 'Clients can earn this reward now.' : 'Rule is saved but not running.'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button className="btn btn-primary" disabled={!draft.name.trim()}
            onClick={() => onSave(draft)}
            style={{ flex: 2, justifyContent: 'center' }}>
            {rule.id ? 'Save changes' : 'Create rule'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder }) {
  return (
    <input value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} style={{
      width: '100%', padding: '10px 12px', borderRadius: 10,
      background: 'var(--surface)', border: '1px solid var(--border-strong)',
      color: 'var(--fg)', fontSize: 14, outline: 'none',
    }} />
  );
}

function MembersTable() {
  const rows = [
    { name: 'Ana Beltrán',   since: '42 days',  points: 4, status: 'Close to reward', reward: 'Book 5, get 1 free' },
    { name: 'Jordan Cole',   since: '128 days', points: 2, status: 'Earning',         reward: 'Book 5, get 1 free' },
    { name: 'Rina Okafor',   since: '6 days',   points: 1, status: 'Welcomed',        reward: 'Friend referral' },
    { name: 'Chris Mendes',  since: '201 days', points: 5, status: 'Ready to redeem', reward: 'Book 5, get 1 free' },
  ];
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <TblHead cols={['Member', 'Member since', 'Points', 'Status', 'Rule']} />
      {rows.map((r, i) => (
        <div key={i} style={rowSty(i)}>
          <div style={{ fontWeight: 550 }}>{r.name}</div>
          <div style={{ color: 'var(--fg-2)' }}>{r.since}</div>
          <div className="mono-num" style={{ fontWeight: 600 }}>{r.points}</div>
          <div><span className={`chip ${r.status === 'Ready to redeem' ? 'chip-accent' : r.status === 'Close to reward' ? 'chip-warn' : 'chip-ok'}`}>
            <span className="chip-dot" />{r.status}
          </span></div>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>{r.reward}</div>
        </div>
      ))}
    </div>
  );
}
function RedemptionsTable() {
  const rows = [
    { date: 'Apr 18', member: 'Chris Mendes', reward: '1 free session',    value: '$85',  rule: 'Book 5, get 1 free' },
    { date: 'Apr 12', member: 'Leah Park',    reward: '$25 account credit',value: '$25',  rule: 'Friend referral' },
    { date: 'Apr 9',  member: 'Ana Beltrán',  reward: '$25 account credit',value: '$25',  rule: 'Friend referral' },
  ];
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <TblHead cols={['Date', 'Member', 'Reward', 'Value', 'Rule']} />
      {rows.map((r, i) => (
        <div key={i} style={rowSty(i)}>
          <div style={{ color: 'var(--fg-2)' }}>{r.date}</div>
          <div style={{ fontWeight: 550 }}>{r.member}</div>
          <div>{r.reward}</div>
          <div className="mono-num" style={{ fontWeight: 600 }}>{r.value}</div>
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>{r.rule}</div>
        </div>
      ))}
    </div>
  );
}
function TblHead({ cols }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${cols.length}, 1fr)`,
      padding: '12px 18px', borderBottom: '1px solid var(--border)',
      fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--muted)', fontWeight: 600,
    }}>{cols.map(c => <div key={c}>{c}</div>)}</div>
  );
}
function rowSty(i) {
  return {
    display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
    padding: '14px 18px', alignItems: 'center', fontSize: 14,
    borderTop: i > 0 ? '1px solid var(--border)' : 'none',
  };
}

window.RewardsView = RewardsView;
